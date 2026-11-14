const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const {
  getKataGoStatus,
  analyzeBadukMove,
  cancelActiveAnalysis,
  readBundledWebWeights,
  shutdownKataGo,
} = require('./katago-bridge.cjs');

let mainWindow = null;

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#14100c',
    title: '3D 정통 바둑 — 수담(手談) v4.0',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const isDev = !app.isPackaged && process.env.ELECTRON_START_URL !== 'file';
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

  if (isDev && process.argv.includes('--dev-server')) {
    mainWindow.loadURL(devServerUrl);
  } else if (!app.isPackaged && !fs.stat(path.join(__dirname, '../dist/index.html')).catch(() => null)) {
    mainWindow.loadURL(devServerUrl);
  } else {
    // Check if dev server is explicitly requested via env, else prefer dist if built or dev URL
    const distIndex = path.join(__dirname, '../dist/index.html');
    fs.access(distIndex)
      .then(() => {
        if (process.env.USE_VITE_DEV === '1') {
          mainWindow.loadURL(devServerUrl);
        } else {
          mainWindow.loadFile(distIndex);
        }
      })
      .catch(() => {
        mainWindow.loadURL(devServerUrl);
      });
  }

  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show();
    }
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11' && mainWindow) {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('sgf:save', async (_event, { content, defaultName }) => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '기보(SGF) 저장',
    defaultPath: defaultName || 'baduk-game.sgf',
    filters: [{ name: 'Smart Game Format (*.sgf)', extensions: ['sgf'] }],
  });
  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }
  await fs.writeFile(result.filePath, content, 'utf8');
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('sgf:open', async () => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '기보(SGF) 불러오기',
    properties: ['openFile'],
    filters: [{ name: 'Smart Game Format (*.sgf)', extensions: ['sgf'] }],
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { canceled: true };
  }
  const filePath = result.filePaths[0];
  const content = await fs.readFile(filePath, 'utf8');
  return { canceled: false, content, fileName: path.basename(filePath) };
});

ipcMain.handle('window:toggleFullscreen', () => {
  if (!mainWindow) return false;
  const next = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(next);
  return next;
});

ipcMain.handle('katago:analyze', (_event, payload) => analyzeBadukMove(payload));
ipcMain.handle('katago:cancel', () => {
  cancelActiveAnalysis();
  return true;
});
ipcMain.handle('katago:status', () => getKataGoStatus());
ipcMain.handle('katago:readWebWeights', () => readBundledWebWeights());

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  shutdownKataGo();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
