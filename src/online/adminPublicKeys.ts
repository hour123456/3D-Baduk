// Public verification & encryption JWKs (verify/encrypt only).

export const ADMIN_KEY_VERSION = 1 as const;

export const ADMIN_SIGN_PUBLIC_JWK: JsonWebKey = {
  "key_ops": [
    "verify"
  ],
  "ext": true,
  "kty": "EC",
  "x": "YYNGgkqvrzRjfTuLz-4Y_9sUsdLcqIKj8ru1RbZRjZ8",
  "y": "vQBde1Vw7py_05b8yv7wLccK8b3Z8p6bbjga_ljeW7o",
  "crv": "P-256"
};

export const ADMIN_ENCRYPT_PUBLIC_JWK: JsonWebKey = {
  "key_ops": [
    "encrypt"
  ],
  "ext": true,
  "kty": "RSA",
  "n": "qzQNVDivVkUg4VRU50XDMbip8Fg-agxrJv28bXO5JDbgGvDjFcRctLXSfkwSMgR3uuWJ8Zkec9AYd4Ql6Mm4GK2yWsgQqAjcuEUoKRsEfZ66XreEp59dMCJ2NF2K4uNiTJoBZa5M0uQ64fPwim4AEfbRT6ALPd2WXVqyaGhjWcFUQ8cCFrMxuteGmjRmNW9p0NsKMuPninRvxv0uk-NruNXB4auYlsu9GvHO5l-bZmbc08AVv0EjbSpLihOTUFliweZ3nJ2L41cYtpiYqS7w4F4603p6jyogcP_PiMSrBn_vxZ_USnaSJ-Ailp5n3jJyFj7l-dwOEmXpfXU8e37O1w",
  "e": "AQAB",
  "alg": "RSA-OAEP-256"
};
