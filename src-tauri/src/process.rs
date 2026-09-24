//! Starting the command-line tools Roer drives.

use std::ffi::OsStr;
use std::process::Command;

/// `Command::new`, minus the console window Windows opens for every console
/// program a GUI app starts — otherwise each git call flashes one on screen.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}
