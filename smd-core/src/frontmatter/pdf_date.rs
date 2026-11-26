use super::PdfDate;

fn days_in_month(year: i32, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
            if leap { 29 } else { 28 }
        }
        _ => 0,
    }
}

fn valid_ymd(year: i32, month: u8, day: u8) -> bool {
    (0..=9999).contains(&year)
        && (1..=12).contains(&month)
        && day >= 1
        && day <= days_in_month(year, month)
}

fn shift_utc_offset(
    mut year: i32,
    mut month: u8,
    mut day: u8,
    hour: u8,
    minute: u8,
    second: u8,
    offset_minutes: i32,
) -> Option<PdfDate> {
    let mut total_minutes = (hour as i32) * 60 + (minute as i32) - offset_minutes;
    while total_minutes < 0 {
        total_minutes += 1440;
        if day > 1 {
            day -= 1;
        } else if month > 1 {
            month -= 1;
            day = days_in_month(year, month);
        } else {
            year -= 1;
            if year < 0 {
                return None;
            }
            month = 12;
            day = 31;
        }
    }
    while total_minutes >= 1440 {
        total_minutes -= 1440;
        let max_day = days_in_month(year, month);
        if day < max_day {
            day += 1;
        } else if month < 12 {
            month += 1;
            day = 1;
        } else {
            year += 1;
            if year > 9999 {
                return None;
            }
            month = 1;
            day = 1;
        }
    }
    let adj_hour = (total_minutes / 60) as u8;
    let adj_minute = (total_minutes % 60) as u8;
    Some(PdfDate {
        year,
        month,
        day,
        time: Some((adj_hour, adj_minute, second)),
    })
}

pub fn parse_pdf_date(raw: &str) -> Option<PdfDate> {
    let s = raw.trim();
    if s.len() < 8 {
        return None;
    }
    // ISO-8601 / RFC-3339: YYYY-MM-DD or YYYY/MM/DD with optional [T ]HH:MM[:SS][.frac][Z|±HH:?MM]
    let sep = s.as_bytes().get(4).copied();
    if matches!(sep, Some(b'-' | b'/')) && s[..4].bytes().all(|b| b.is_ascii_digit()) {
        let rest = &s[5..];
        let (month_str, after_month) = rest.split_once(sep.unwrap() as char)?;
        if month_str.is_empty()
            || month_str.len() > 2
            || !month_str.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        let day_len = after_month.bytes().take_while(|b| b.is_ascii_digit()).count();
        if day_len == 0 || day_len > 2 {
            return None;
        }
        let year: i32 = s[..4].parse().ok()?;
        let month: u8 = month_str.parse().ok()?;
        let day: u8 = after_month[..day_len].parse().ok()?;
        if !valid_ymd(year, month, day) {
            return None;
        }
        let tail = after_month[day_len..].trim();
        if tail.is_empty() {
            return Some(PdfDate { year, month, day, time: None });
        }
        let time_part = after_month[day_len..]
            .strip_prefix(['T', 't', ' '])?
            .trim();
        if time_part.len() < 5 {
            return None;
        }
        let hour: u8 = time_part.get(0..2)?.parse().ok()?;
        if time_part.as_bytes().get(2) != Some(&b':') {
            return None;
        }
        let minute: u8 = time_part.get(3..5)?.parse().ok()?;
        if hour > 23 || minute > 59 {
            return None;
        }
        let mut rem = &time_part[5..];
        let mut second = 0u8;
        if let Some(sec_rest) = rem.strip_prefix(':') {
            if sec_rest.len() < 2 {
                return None;
            }
            second = sec_rest[..2].parse().ok()?;
            if second > 59 {
                return None;
            }
            rem = &sec_rest[2..];
            if let Some(frac) = rem.strip_prefix('.') {
                let digits = frac.bytes().take_while(|b| b.is_ascii_digit()).count();
                if digits == 0 {
                    return None;
                }
                rem = &frac[digits..];
            }
        }
        let rem = rem.trim();
        if rem.is_empty() || rem.eq_ignore_ascii_case("z") {
            return Some(PdfDate {
                year,
                month,
                day,
                time: Some((hour, minute, second)),
            });
        }
        if let Some(sign) = rem.chars().next().filter(|c| *c == '+' || *c == '-') {
            let tz = &rem[1..];
            let (tz_h, tz_m) = if let Some((h, m)) = tz.split_once(':') {
                (h, m)
            } else if tz.len() == 4 {
                (&tz[..2], &tz[2..])
            } else if tz.len() == 2 {
                (tz, "00")
            } else {
                return None;
            };
            let h: i32 = tz_h.parse().ok()?;
            let m: i32 = tz_m.parse().ok()?;
            if !(0..=23).contains(&h) || !(0..=59).contains(&m) {
                return None;
            }
            let offset_mins = (h * 60 + m) * if sign == '+' { 1 } else { -1 };
            return shift_utc_offset(year, month, day, hour, minute, second, offset_mins);
        }
        return None;
    }

    // Named month formats such as "March 15, 2026" or "15 March 2026"
    let cleaned = s.replace(',', " ");
    let tokens: Vec<&str> = cleaned.split_whitespace().collect();
    if tokens.len() == 3 {
        let month_num = |m: &str| -> Option<u8> {
            match m.to_ascii_lowercase().as_str() {
                "jan" | "january" => Some(1),
                "feb" | "february" => Some(2),
                "mar" | "march" => Some(3),
                "apr" | "april" => Some(4),
                "may" => Some(5),
                "jun" | "june" => Some(6),
                "jul" | "july" => Some(7),
                "aug" | "august" => Some(8),
                "sep" | "sept" | "september" => Some(9),
                "oct" | "october" => Some(10),
                "nov" | "november" => Some(11),
                "dec" | "december" => Some(12),
                _ => None,
            }
        };
        if let (Some(month), Ok(day), Ok(year)) =
            (month_num(tokens[0]), tokens[1].parse::<u8>(), tokens[2].parse::<i32>())
        {
            if valid_ymd(year, month, day) {
                return Some(PdfDate { year, month, day, time: None });
            }
        }
        if let (Ok(day), Some(month), Ok(year)) =
            (tokens[0].parse::<u8>(), month_num(tokens[1]), tokens[2].parse::<i32>())
        {
            if valid_ymd(year, month, day) {
                return Some(PdfDate { year, month, day, time: None });
            }
        }
    }
    None
}
