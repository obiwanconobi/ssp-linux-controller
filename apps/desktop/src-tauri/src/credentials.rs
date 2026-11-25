//! Optional OS keyring storage for device passwords.
//!
//! This is deliberately a small module: the password is only used to compute
//! the device's challenge hash, and is never written to logs or app data.
//! Linux uses Secret Service, macOS the Keychain, and Windows Credential
//! Manager. Mobile builds fall back to an in-memory session prompt.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
const SERVICE: &str = "StompStation";

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn load(address: &str) -> Option<String> {
    let entry = keyring::Entry::new(SERVICE, address).ok()?;
    match entry.get_password() {
        Ok(password) => Some(password),
        Err(keyring::Error::NoEntry) => None,
        Err(error) => {
            eprintln!("keyring password lookup failed: {error}");
            None
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn save(address: &str, password: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, address)
        .map_err(|error| format!("keyring unavailable: {error}"))?;
    entry
        .set_password(password)
        .map_err(|error| format!("could not save the password: {error}"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn forget(address: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, address)
        .map_err(|error| format!("keyring unavailable: {error}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("could not remove the saved password: {error}")),
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn load(_address: &str) -> Option<String> {
    None
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn save(_address: &str, _password: &str) -> Result<(), String> {
    Err("saving a device password is not available on this platform yet".into())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn forget(_address: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires an unlocked desktop keyring"]
    fn keyring_round_trip() {
        let address = "test:stompstation:auth-smoke";
        forget(address).unwrap();
        save(address, "test-password").unwrap();
        assert_eq!(load(address).as_deref(), Some("test-password"));
        forget(address).unwrap();
        assert_eq!(load(address), None);
    }
}
