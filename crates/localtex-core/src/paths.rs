use std::path::{Component, Path, PathBuf};

pub fn safe_path(root: &Path, name: &str, must_exist: bool) -> Result<PathBuf, String> {
    let rel = Path::new(name);
    if name.is_empty()
        || rel.is_absolute()
        || rel.components().any(|c| !matches!(c, Component::Normal(_)))
        || name.contains(':')
    {
        return Err("Use a relative path inside this project.".into());
    }
    let path = root.join(rel);
    let canonical = if must_exist {
        path.canonicalize()
    } else {
        path.parent().ok_or("Invalid file path")?.canonicalize()
    }
    .map_err(|e| e.to_string())?;
    if !canonical.starts_with(root) {
        return Err("This path leaves the project folder.".into());
    }
    if path.exists()
        && !path
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(root)
    {
        return Err("Links outside the project are not accessible.".into());
    }
    Ok(path)
}

/// External TeX tools expect ordinary Windows paths, not Rust's verbatim paths.
pub fn tool_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
    }
}

/// MiKTeX records a source file under its 8.3 short name when the path holds characters
/// outside the system code page (for example Bangla folder names), so SyncTeX lookups
/// must try that form, and results must be turned back into the real path.
#[cfg(windows)]
fn convert(path: &str, long: bool) -> Option<String> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Storage::FileSystem::{GetLongPathNameW, GetShortPathNameW};
    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let call = |buffer: &mut [u16]| unsafe {
        let size = buffer.len() as u32;
        if long {
            GetLongPathNameW(wide.as_ptr(), buffer.as_mut_ptr(), size)
        } else {
            GetShortPathNameW(wide.as_ptr(), buffer.as_mut_ptr(), size)
        }
    };
    // With an empty buffer both functions report the size they need, including the terminator.
    let needed = call(&mut []);
    if needed == 0 {
        return None;
    }
    let mut buffer = vec![0u16; needed as usize];
    let written = call(&mut buffer);
    if written == 0 || written >= needed {
        return None;
    }
    Some(
        std::ffi::OsString::from_wide(&buffer[..written as usize])
            .to_string_lossy()
            .into_owned(),
    )
}
#[cfg(not(windows))]
fn convert(_path: &str, _long: bool) -> Option<String> {
    None
}
/// The 8.3 form of an existing path, when it differs from the path itself.
pub fn short_path(path: &str) -> Option<String> {
    convert(path, false).filter(|short| short != path)
}
/// The full form of an existing path that may contain 8.3 components.
pub fn long_path(path: &str) -> Option<String> {
    convert(path, true)
}

/// Creates `link` as a directory junction to `target`. Junctions need no administrator
/// rights; removing the link with `fs::remove_dir` leaves the target untouched.
#[cfg(windows)]
pub fn junction(link: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GENERIC_WRITE, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, OPEN_EXISTING,
        },
        System::IO::DeviceIoControl,
    };
    const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    let wide = |text: &str| -> Vec<u16> { std::ffi::OsStr::new(text).encode_wide().collect() };
    let target = tool_path(target);
    let substitute = wide(&format!(r"\??\{target}"));
    let print = wide(&target);
    // REPARSE_DATA_BUFFER for a mount point: names are stored back to back, each terminated.
    let mut names = substitute.clone();
    names.push(0);
    names.extend(&print);
    names.push(0);
    let header = |value: u16| value.to_le_bytes();
    let mut buffer = Vec::with_capacity(16 + names.len() * 2);
    let data_length = (8 + names.len() * 2) as u16;
    buffer.extend(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buffer.extend(header(data_length));
    buffer.extend(header(0));
    buffer.extend(header(0));
    buffer.extend(header((substitute.len() * 2) as u16));
    buffer.extend(header(((substitute.len() + 1) * 2) as u16));
    buffer.extend(header((print.len() * 2) as u16));
    buffer.extend(names.iter().flat_map(|unit| unit.to_le_bytes()));
    std::fs::create_dir(link)?;
    let path: Vec<u16> = link.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        let handle = CreateFileW(
            path.as_ptr(),
            GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        );
        if handle == INVALID_HANDLE_VALUE {
            Err(std::io::Error::last_os_error())
        } else {
            let mut returned = 0;
            let ok = DeviceIoControl(
                handle,
                FSCTL_SET_REPARSE_POINT,
                buffer.as_ptr().cast(),
                buffer.len() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            );
            let error = std::io::Error::last_os_error();
            CloseHandle(handle);
            if ok == 0 {
                Err(error)
            } else {
                Ok(())
            }
        }
    };
    if result.is_err() {
        let _ = std::fs::remove_dir(link);
    }
    result
}
#[cfg(not(windows))]
pub fn junction(_link: &Path, _target: &Path) -> std::io::Result<()> {
    Err(std::io::ErrorKind::Unsupported.into())
}

/// Moves a file or folder to the Recycle Bin, so a deletion can be undone from Windows.
#[cfg(windows)]
pub fn recycle(path: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };
    // The shell takes a list of paths ended by an empty one, hence two terminators.
    let from: Vec<u16> = std::ffi::OsStr::new(&tool_path(path))
        .encode_wide()
        .chain([0, 0])
        .collect();
    let mut operation = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT) as u16,
        ..Default::default()
    };
    let code = unsafe { SHFileOperationW(&mut operation) };
    if code != 0 || operation.fAnyOperationsAborted != 0 {
        return Err(std::io::Error::other(format!(
            "Windows could not move it to the Recycle Bin (error {code}). Close any program using it, then try again."
        )));
    }
    Ok(())
}
#[cfg(not(windows))]
pub fn recycle(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn short_names_convert_back_to_the_real_path() {
        let temporary = tempfile::tempdir().unwrap();
        let folder = temporary.path().join("গবেষণা paper");
        std::fs::create_dir(&folder).unwrap();
        let file = folder.join("main.tex");
        std::fs::write(&file, "").unwrap();
        let real = long_path(&tool_path(&file)).unwrap();
        assert!(real.ends_with(r"গবেষণা paper\main.tex"), "{real}");
        // Volumes without 8.3 names have no short form; the round trip must still hold.
        let short = short_path(&real).unwrap_or_else(|| real.clone());
        assert_eq!(long_path(&short).unwrap(), real);
        assert!(long_path(r"C:\localtex-missing\main.tex").is_none());
    }
    #[cfg(windows)]
    #[test]
    fn a_junction_reaches_the_target_and_removing_it_keeps_the_target() {
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path().join("গবেষণা & 100% paper");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("main.tex"), "hello").unwrap();
        let link = temporary.path().join("link");
        junction(&link, &target).unwrap();
        assert_eq!(
            std::fs::read_to_string(link.join("main.tex")).unwrap(),
            "hello"
        );
        std::fs::write(link.join("through link.tex"), "x").unwrap();
        assert!(target.join("through link.tex").is_file());
        assert_eq!(link.canonicalize().unwrap(), target.canonicalize().unwrap());
        std::fs::remove_dir(&link).unwrap();
        assert!(!link.exists());
        assert!(target.join("main.tex").is_file());
    }
    #[test]
    fn rejects_traversal_absolute_paths_and_windows_streams() {
        let root = std::env::current_dir().unwrap().canonicalize().unwrap();
        for name in [
            "",
            "..",
            "../secret.tex",
            "C:\\secret.tex",
            "a/../../secret.tex",
            "/etc/passwd",
            "file.tex:stream",
        ] {
            assert!(safe_path(&root, name, false).is_err(), "{name}");
        }
    }
    #[test]
    fn accepts_unicode_names_inside_the_project() {
        let root = std::env::current_dir().unwrap().canonicalize().unwrap();
        assert_eq!(
            safe_path(&root, "গবেষণা paper.tex", false).unwrap(),
            root.join("গবেষণা paper.tex")
        );
    }
    #[test]
    fn removes_verbatim_prefix_for_external_tools() {
        assert_eq!(
            tool_path(Path::new(r"\\?\D:\My paper\main.tex")),
            r"D:\My paper\main.tex"
        );
        assert_eq!(
            tool_path(Path::new(r"\\?\UNC\server\paper\main.tex")),
            r"\\server\paper\main.tex"
        );
        assert_eq!(tool_path(Path::new("main.tex")), "main.tex");
    }
}
