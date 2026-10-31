//! Text encodings for source files. UTF-8 is the default; files that are not valid UTF-8
//! (older projects written with `\usepackage[latin1]{inputenc}` or `ansinew`) are read as
//! Windows-1252, a superset of the printable Latin-1 characters.

/// Windows-1252 bytes 0x80 to 0x9F. The five unassigned bytes map to the matching C1
/// control characters, as browsers do, so every byte value round-trips exactly. A file in
/// some other legacy encoding may then display wrongly, but saving it never corrupts it.
const HIGH: [char; 32] = [
    '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008D}', '\u{017D}', '\u{008F}',
    '\u{0090}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{009D}', '\u{017E}', '\u{0178}',
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Windows1252,
}
impl Encoding {
    pub fn name(self) -> &'static str {
        match self {
            Encoding::Utf8 => "UTF-8",
            Encoding::Windows1252 => "Windows-1252",
        }
    }
}

/// Whether the source loads inputenc with a Latin-1 family option. A file that is still
/// plain ASCII must keep that encoding, or the first accented letter typed would be
/// written as UTF-8 and misread by LaTeX.
fn declares_latin1(text: &str) -> bool {
    text.lines()
        .map(|line| line.split('%').next().unwrap_or(""))
        .filter_map(|line| line.find("]{inputenc}").map(|end| &line[..end]))
        .filter_map(|before| {
            before
                .rfind("\\usepackage[")
                .map(|start| &before[start + "\\usepackage[".len()..])
        })
        .any(|options| {
            options
                .split(',')
                .any(|option| matches!(option.trim(), "latin1" | "ansinew" | "cp1252"))
        })
}

/// The encoding a file's bytes are in.
pub fn detect(bytes: &[u8]) -> Encoding {
    match std::str::from_utf8(bytes) {
        Ok(text) if !(text.is_ascii() && declares_latin1(text)) => Encoding::Utf8,
        _ => Encoding::Windows1252,
    }
}

pub fn decode(bytes: &[u8], encoding: Encoding) -> String {
    match encoding {
        Encoding::Utf8 => String::from_utf8_lossy(bytes).into_owned(),
        Encoding::Windows1252 => bytes
            .iter()
            .map(|&byte| match byte {
                0x80..=0x9F => HIGH[usize::from(byte - 0x80)],
                _ => char::from(byte),
            })
            .collect(),
    }
}

/// Encodes text, or returns the first character the encoding cannot store.
pub fn encode(text: &str, encoding: Encoding) -> Result<Vec<u8>, char> {
    match encoding {
        Encoding::Utf8 => Ok(text.as_bytes().to_vec()),
        Encoding::Windows1252 => text
            .chars()
            .map(|c| match u32::from(c) {
                code @ (0..=0x7F | 0xA0..=0xFF) => Ok(code as u8),
                _ => HIGH
                    .iter()
                    .position(|&high| high == c)
                    .map(|index| 0x80 + index as u8)
                    .ok_or(c),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_windows_1252_byte_round_trips() {
        let bytes: Vec<u8> = (0..=255).collect();
        let text = decode(&bytes, Encoding::Windows1252);
        assert_eq!(encode(&text, Encoding::Windows1252).unwrap(), bytes);
        assert_eq!(decode(b"Caf\xe9 \x80", Encoding::Windows1252), "Café €");
    }
    #[test]
    fn characters_outside_the_encoding_are_reported() {
        assert_eq!(encode("Café ক", Encoding::Windows1252), Err('ক'));
    }
    #[test]
    fn detection_follows_the_bytes_and_the_inputenc_declaration() {
        assert_eq!(detect("Café".as_bytes()), Encoding::Utf8);
        assert_eq!(detect(b"Caf\xe9"), Encoding::Windows1252);
        assert_eq!(detect(b"plain ascii"), Encoding::Utf8);
        assert_eq!(
            detect(b"\\usepackage[T1]{fontenc}\n\\usepackage[latin1]{inputenc}\n"),
            Encoding::Windows1252
        );
        assert_eq!(
            detect(b"% \\usepackage[latin1]{inputenc}\n\\usepackage[utf8]{inputenc}\n"),
            Encoding::Utf8
        );
    }
}
