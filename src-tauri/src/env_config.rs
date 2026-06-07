use std::process::Command;

/// Read a user environment variable.
/// First checks the current process environment, then falls back to
/// reading from the Windows registry (HKCU\Environment) for persistence.
pub fn read_config(key: &str) -> Option<String> {
    // Try current process environment first (set via set_var in same session)
    if let Ok(val) = std::env::var(key) {
        if !val.is_empty() {
            return Some(val);
        }
    }

    // Fall back to registry for values saved via setx in previous sessions
    read_from_registry(key)
}

/// Write a user environment variable persistently.
/// Uses `setx` for permanent storage + `std::env::set_var` for current process.
pub fn write_config(key: &str, value: &str) -> Result<(), String> {
    // 1. Set in current process for immediate availability
    std::env::set_var(key, value);

    // 2. Persist to user environment via setx
    let output = Command::new("setx")
        .arg(key)
        .arg(value)
        .output()
        .map_err(|e| format!("Failed to run setx: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("setx failed: {}", stderr));
    }

    Ok(())
}

/// Delete a user environment variable (persistent + current process).
pub fn delete_config(key: &str) -> Result<(), String> {
    // 1. Remove from current process
    std::env::remove_var(key);

    // 2. Delete from registry (setx with empty value doesn't delete, use reg delete)
    let output = Command::new("reg")
        .args(["delete", "HKCU\\Environment", "/v", key, "/f"])
        .output()
        .map_err(|e| format!("Failed to run reg delete: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // "The system was unable to find the specified registry key or value" is OK
        if !stderr.contains("unable to find") {
            return Err(format!("reg delete failed: {}", stderr));
        }
    }

    Ok(())
}

fn read_from_registry(key: &str) -> Option<String> {
    let output = Command::new("reg")
        .args(["query", "HKCU\\Environment", "/v", key])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // reg query output format:
    // HKEY_CURRENT_USER\Environment
    //     VAR_NAME    REG_SZ    value
    // or
    //     VAR_NAME    REG_EXPAND_SZ    value

    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with(key) {
            // Split on whitespace, take everything after the type field
            let parts: Vec<&str> = trimmed.splitn(3, |c: char| c.is_whitespace()).collect();
            if parts.len() >= 3 {
                return Some(parts[2].to_string());
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_write_read_delete_config() {
        let test_key = "SRT_REPAIR_TEST_VAR";
        let test_value = "test-value-123";

        // Clean up first
        let _ = delete_config(test_key);

        // Write
        write_config(test_key, test_value).unwrap();

        // Read from current process (set_var)
        let val = read_config(test_key);
        assert_eq!(val, Some(test_value.to_string()));

        // Clean up
        delete_config(test_key).unwrap();
        assert!(read_config(test_key).is_none());
    }

    #[test]
    fn test_read_missing_returns_none() {
        assert_eq!(read_config("SRT_REPAIR_NONEXISTENT_VAR_XYZ"), None);
    }
}
