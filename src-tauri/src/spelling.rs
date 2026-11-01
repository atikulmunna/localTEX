//! Spell checking through the Windows spell checker: the same dictionaries WebView2 uses,
//! including any language installed in Windows. Unlike the browser's built-in checker, it
//! reads the whole text, not only words as they are typed. Offsets are UTF-16 code units,
//! which is how JavaScript strings count.
use localtex_core::workspace::Result;
use serde::Serialize;

#[derive(Serialize)]
pub struct Misspelling {
    pub from: u32,
    pub to: u32,
}

#[cfg(windows)]
mod windows_checker {
    use super::{Misspelling, Result};
    use windows::{
        core::{HSTRING, PWSTR},
        Win32::{
            Globalization::{
                ISpellChecker, ISpellCheckerFactory, SpellCheckerFactory, CORRECTIVE_ACTION_DELETE,
            },
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, IEnumString, CLSCTX_INPROC_SERVER,
                COINIT_MULTITHREADED,
            },
        },
    };

    fn factory() -> Result<ISpellCheckerFactory> {
        unsafe {
            // Blocking worker threads join the multithreaded apartment; repeating it is harmless.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("Windows spell checking is unavailable: {e}"))
        }
    }
    fn strings(list: IEnumString) -> Vec<String> {
        let mut found = Vec::new();
        loop {
            let mut item = [PWSTR::null()];
            let mut fetched = 0;
            let result = unsafe { list.Next(&mut item, Some(&mut fetched)) };
            if result.is_err() || fetched == 0 {
                break;
            }
            unsafe {
                found.push(item[0].to_string().unwrap_or_default());
                CoTaskMemFree(Some(item[0].0 as _));
            }
        }
        found
    }
    fn checker(language: &str) -> Result<ISpellChecker> {
        let factory = factory()?;
        let tag = HSTRING::from(language);
        unsafe {
            if !factory
                .IsSupported(&tag)
                .map_err(|e| e.to_string())?
                .as_bool()
            {
                return Err(format!(
                    "Windows has no spelling dictionary for {language}. Add the language in Windows Settings."
                ));
            }
            factory.CreateSpellChecker(&tag).map_err(|e| e.to_string())
        }
    }
    pub fn languages() -> Result<Vec<String>> {
        Ok(strings(
            unsafe { factory()?.SupportedLanguages() }.map_err(|e| e.to_string())?,
        ))
    }
    pub fn check(language: &str, text: &str) -> Result<Vec<Misspelling>> {
        let checker = checker(language)?;
        let errors = unsafe { checker.Check(&HSTRING::from(text)) }.map_err(|e| e.to_string())?;
        let mut found = Vec::new();
        loop {
            let mut error = None;
            // S_FALSE (1) marks the end of the list.
            if unsafe { errors.Next(&mut error) }.0 != 0 {
                break;
            }
            let Some(error) = error else { break };
            unsafe {
                // Repeated words ("the the") are reported for deletion; LaTeX source makes those
                // unreliable once commands are blanked out, so only misspellings are kept.
                if error.CorrectiveAction().map_err(|e| e.to_string())? == CORRECTIVE_ACTION_DELETE
                {
                    continue;
                }
                let from = error.StartIndex().map_err(|e| e.to_string())?;
                let length = error.Length().map_err(|e| e.to_string())?;
                found.push(Misspelling {
                    from,
                    to: from + length,
                });
            }
        }
        Ok(found)
    }
    pub fn suggest(language: &str, word: &str) -> Result<Vec<String>> {
        let list = unsafe { checker(language)?.Suggest(&HSTRING::from(word)) }
            .map_err(|e| e.to_string())?;
        Ok(strings(list).into_iter().take(8).collect())
    }
    pub fn add(language: &str, word: &str) -> Result<()> {
        unsafe { checker(language)?.Add(&HSTRING::from(word)) }.map_err(|e| e.to_string())
    }
}
#[cfg(windows)]
pub use windows_checker::{add, check, languages, suggest};

#[cfg(not(windows))]
pub fn languages() -> Result<Vec<String>> {
    Ok(Vec::new())
}
#[cfg(not(windows))]
pub fn check(_language: &str, _text: &str) -> Result<Vec<Misspelling>> {
    Err("Spell checking needs Windows.".into())
}
#[cfg(not(windows))]
pub fn suggest(_language: &str, _word: &str) -> Result<Vec<String>> {
    Ok(Vec::new())
}
#[cfg(not(windows))]
pub fn add(_language: &str, _word: &str) -> Result<()> {
    Err("Spell checking needs Windows.".into())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn misspellings_are_found_with_utf16_offsets_and_suggestions() {
        let languages = languages().unwrap();
        let Some(english) = languages.iter().find(|l| l.starts_with("en")) else {
            return; // No English dictionary on this machine.
        };
        // "বাংলা " is 6 UTF-16 units, so "Thsi" starts at 6.
        let found = check(english, "বাংলা Thsi is a tset.").unwrap();
        let ranges: Vec<_> = found.iter().map(|m| (m.from, m.to)).collect();
        assert!(
            ranges.contains(&(6, 10)) && ranges.contains(&(16, 20)),
            "{ranges:?}"
        );
        assert!(!ranges.contains(&(13, 15)), "{ranges:?}");
        assert!(suggest(english, "tset")
            .unwrap()
            .iter()
            .any(|s| s == "test"));
    }
}
