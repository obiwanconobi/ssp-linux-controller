//! VoidX password/token authentication.
//!
//! Firmware with a non-empty `root\sys\pwd` prefixes every response with
//! `token <nonce> y|n`. Protected commands must be sent as:
//!
//! ```text
//! token <hash>\r\n<command>\r\n\0
//! ```
//!
//! where `<hash>` is `hash(password + nonce)`. The hash is the firmware's
//! custom 8-byte-state function; [`token_hash`] is byte-compatible with
//! `Security::generateHash` in the 2.5.3 image. The tables are identical in
//! 2.2.6.

use crate::command;

/// ASCII salt appended to every hash input.
pub const SALT: &[u8] = b"voidxdevteam";

const INITIAL_STATE: [u8; 8] = [0x4e, 0x02, 0x4c, 0x4d, 0x7b, 0x7c, 0x03, 0x13];
const RK1: [usize; 8] = [1, 5, 6, 3, 2, 0, 7, 4];
const RK2: [usize; 8] = [5, 0, 6, 4, 2, 3, 1, 7];

const fn hex_nibble(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        b'A'..=b'F' => byte - b'A' + 10,
        _ => panic!("invalid hexadecimal table"),
    }
}

const fn parse_hex<const N: usize>(hex: &str) -> [u8; N] {
    let bytes = hex.as_bytes();
    assert!(bytes.len() == N * 2, "hex table has the wrong length");
    let mut out = [0u8; N];
    let mut index = 0;
    while index < N {
        out[index] = (hex_nibble(bytes[index * 2]) << 4) | hex_nibble(bytes[index * 2 + 1]);
        index += 1;
    }
    out
}

const KEYS1: [u8; 256] = parse_hex(concat!(
    "3f6685dd0060106ef59294d4c21328483a4990bc8a5fb0df7616bb8439e1e4f1",
    "502c2b99bde7231c9802aebe9f1747af3c420bd1cd302a141b454146defe2e01",
    "1ac604ac745c61d9a311e0536ab169379371364f344ee954fa5db97896893ddc",
    "eecfc48733fb7c822fd37e8827e63e35b6ccfcc121b7f67aade50363654b68eb",
    "1ec0771295d2f9d58359db329a8c1829526bc80a2d0e055873f28da17ba9a56f",
    "3831c5cba84dd6b2151970d01dc3755b0c44b5a7e36d5aeac9678ba45e43ceb8",
    "9164f4d808a6edec1f97bfba510d9c079ba255e8f8b424f379abc7fde2f7819d",
    "40d7da26564c720f09f0578f62863bef6c9e250680b320ca7d8e4a22ffa0aa7f",
));

const KEYS2: [u8; 256] = parse_hex(concat!(
    "fc768ac603f086df968b9316e8d0c56aca17aa6dbde2b3fd3cd65b384c5fc2a5",
    "8e50ff66c0dca604b4805d4bbadde69a055240a36c75f659235e1363b2994248",
    "240cb52fd17a9c9144094fec025828d9602522d4d2b91c8f7babbe4570899ee5",
    "a13df1ee9f10d8e43400a0c37c07277815f562dac8541856ce6e0e46399082ac",
    "9464f7bf303a5aa8afe7de206f12d5b1ebf9e3377fb00db80aa4c19711c7793b",
    "844735a9f3bcd7333fb674bbcc5cfe8dcb2a95e9731988ef4dad432b2c611ba7d",
    "3c4db6983680836ea6567f49dcd1ecfa2018c4a511f26417d068514297efa3efb",
    "5532e0ed1df2b74e49f8e192ae53c91a9b81770f212d0b987157722e6b3187",
));

/// Hash an arbitrary byte string with the firmware's salted hash.
pub fn hash_bytes(input: &[u8]) -> String {
    let mut data = Vec::with_capacity(input.len() + SALT.len());
    data.extend_from_slice(input);
    data.extend_from_slice(SALT);

    let mut state = INITIAL_STATE;
    for (index, &byte) in data.iter().enumerate() {
        let j = index & 7;
        let a = RK1[j];
        let b = RK2[index & 6];
        let e = RK2[j];
        let f = RK1[5 & index];

        let mut h = state[j]
            .wrapping_add(KEYS1[state[a] as usize])
            .wrapping_add(index as u8)
            .wrapping_add(byte);
        state[j] = h;

        h = h.wrapping_add(KEYS2[(state[e].wrapping_add(index as u8)) as usize]);
        state[j] = h;

        h = h.wrapping_add(KEYS1[state[b] as usize]);
        state[j] = h;

        h = h.wrapping_add(KEYS2[state[f] as usize]);
        state[j] = h;

        let mut x = KEYS1[state[index & 2] as usize].wrapping_add(state[e]);
        state[e] = x;

        x = x.wrapping_add(KEYS2[state[index & 3] as usize]);
        state[e] = x;

        x = KEYS1[state[5 & index] as usize].wrapping_add(state[a]);
        state[a] = x;

        // The firmware computes `32 - i` in a 32-bit register and stores the
        // low byte. wrapping_sub reproduces that for inputs longer than 32
        // bytes (long passwords).
        x = x
            .wrapping_add(KEYS2[state[j] as usize])
            .wrapping_add(0x20u32.wrapping_sub(index as u32) as u8);
        state[a] = x;
    }

    format!(
        "{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}",
        state[0], state[1], state[2], state[3], state[4], state[5], state[6], state[7]
    )
}

/// Hash the password challenge: `H(password + nonce)`.
pub fn token_hash(password: &str, nonce: &str) -> String {
    let mut input = Vec::with_capacity(password.len() + nonce.len());
    input.extend_from_slice(password.as_bytes());
    input.extend_from_slice(nonce.as_bytes());
    hash_bytes(&input)
}

/// Encode an authenticated request: `token <hash>\r\n<command>\r\n\0`.
///
/// `command` must not include the transport suffix.
pub fn authenticated_command(hash: &str, command: &str) -> Vec<u8> {
    let body = format!("token {hash}\r\n{command}");
    command::encode(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_matches_firmware_vectors() {
        assert_eq!(hash_bytes(b""), "B005D790879EB63F");
        assert_eq!(hash_bytes(b"password"), "75FEFAE0FFD86717");
        assert_eq!(hash_bytes(b"0123456789ABCDEF"), "0920A852DE3D7EAE");
        assert_eq!(hash_bytes(b"password0123456789ABCDEF"), "5D56506E30C690B1");
        assert_eq!(hash_bytes(b"hunter2A1B2C3D4E5F60718"), "DFE4CAD42781C362");
        // More than 32 bytes exercises the `32 - i` wrapping path.
        assert_eq!(hash_bytes(&b"a".repeat(40)), "B10CC6BBC182BC44");
        assert_eq!(hash_bytes(&b"a".repeat(100)), "E9E1AEBF92BE2B1A");
    }

    #[test]
    fn token_hash_is_case_sensitive_and_deterministic() {
        let first = token_hash("password", "0123456789ABCDEF");
        assert_eq!(first, token_hash("password", "0123456789ABCDEF"));
        assert_eq!(first, "5D56506E30C690B1");
        assert_ne!(first, token_hash("Password", "0123456789ABCDEF"));
        assert_ne!(first, token_hash("password", "0123456789abcdef"));
    }

    #[test]
    fn authenticated_command_shape() {
        let bytes = authenticated_command("ABCDEF0123456789", r#"write root\a:{"value":1}"#);
        assert_eq!(
            bytes,
            b"token ABCDEF0123456789\r\nwrite root\\a:{\"value\":1}\r\n\0"
        );
    }
}
