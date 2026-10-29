//! A compiler and every subprocess it creates belong to the app's lifetime.
use std::process::Child;

#[cfg(windows)]
pub struct ProcessJob(usize);

#[cfg(windows)]
impl ProcessJob {
    pub fn attach(child: &Child) -> std::io::Result<Self> {
        use std::{
            mem::{size_of, zeroed},
            os::windows::io::AsRawHandle,
            ptr::null,
        };
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        // The handle is owned by this object. Only job APIs use it, and the OS
        // supports sharing a job handle between threads.
        unsafe {
            let handle = CreateJobObjectW(null(), null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(handle);
                return Err(error);
            }
            Ok(Self(handle as usize))
        }
    }
    pub fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0 as _, 1);
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        process::Stdio,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    #[test]
    fn terminating_a_job_also_stops_its_grandchild() {
        let mut parent=crate::process::command("powershell.exe").args([
            "-NoProfile","-NonInteractive","-Command",
            "$worker = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30' -WindowStyle Hidden -PassThru; Write-Output $worker.Id; Start-Sleep -Seconds 30"
        ]).stdout(Stdio::piped()).spawn().unwrap();
        let job = ProcessJob::attach(&parent).unwrap();
        let mut pid = String::new();
        BufReader::new(parent.stdout.take().unwrap())
            .read_line(&mut pid)
            .unwrap();
        let pid: u32 = pid.trim().parse().unwrap();
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        assert!(!handle.is_null());
        job.terminate();
        parent.wait().unwrap();
        let start = Instant::now();
        let mut exit_code = 259;
        while exit_code == 259 && start.elapsed() < Duration::from_secs(3) {
            unsafe {
                GetExitCodeProcess(handle, &mut exit_code);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        unsafe {
            CloseHandle(handle);
        }
        assert_ne!(
            exit_code, 259,
            "The grandchild must not survive cancellation"
        );
    }
}

#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

#[cfg(not(windows))]
pub struct ProcessJob;
#[cfg(not(windows))]
impl ProcessJob {
    pub fn attach(_child: &Child) -> std::io::Result<Self> {
        Ok(Self)
    }
    pub fn terminate(&self) {}
}
