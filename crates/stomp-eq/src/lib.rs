//! Four-band output EQ response math.
//!
//! The firmware exposes four bands (low shelf, two bells, high shelf). The UI
//! draws the same RBJ cookbook response the Python client used at 48 kHz.

use serde::{Deserialize, Serialize};

pub const DEFAULT_SAMPLE_RATE: f64 = 48_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BandType {
    LowShelf,
    HighShelf,
    Bell,
    LowPass,
    HighPass,
    Notch,
}

impl BandType {
    pub fn code(self) -> &'static str {
        match self {
            Self::LowShelf => "LPS",
            Self::HighShelf => "HPS",
            Self::Bell => "BP",
            Self::LowPass => "LP",
            Self::HighPass => "HP",
            Self::Notch => "NOTCH",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::LowShelf => "Low shelf",
            Self::HighShelf => "High shelf",
            Self::Bell => "Bell",
            Self::LowPass => "Low pass",
            Self::HighPass => "High pass",
            Self::Notch => "Notch",
        }
    }

    /// Firmware style strings vary; accept the spellings seen in the wild.
    pub fn parse(text: &str) -> Self {
        let normalized = text.trim().to_ascii_uppercase().replace(['_', '-'], " ");
        match normalized.as_str() {
            "LPS" | "LOW SHELF" | "LOWSHELF" | "LS" | "SHELF LOW" => Self::LowShelf,
            "HPS" | "HIGH SHELF" | "HIGHSHELF" | "HS" | "SHELF HIGH" => Self::HighShelf,
            "LP" | "LOW PASS" | "LOWPASS" => Self::LowPass,
            "HP" | "HIGH PASS" | "HIGHPASS" => Self::HighPass,
            "NOTCH" | "BAND STOP" => Self::Notch,
            _ => Self::Bell,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EqBand {
    pub index: usize,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_band_type")]
    pub kind: BandType,
    pub frequency: f64,
    pub gain_db: f64,
    pub q: f64,
}

fn default_true() -> bool {
    true
}

fn default_band_type() -> BandType {
    BandType::Bell
}

impl EqBand {
    pub fn new(index: usize, kind: BandType, frequency: f64, gain_db: f64, q: f64) -> Self {
        Self {
            index,
            enabled: true,
            kind,
            frequency,
            gain_db,
            q,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Biquad {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a0: f64,
    pub a1: f64,
    pub a2: f64,
}

impl Biquad {
    pub fn normalized(&self) -> Self {
        let a0 = if self.a0 == 0.0 { 1.0 } else { self.a0 };
        Self {
            b0: self.b0 / a0,
            b1: self.b1 / a0,
            b2: self.b2 / a0,
            a0: 1.0,
            a1: self.a1 / a0,
            a2: self.a2 / a0,
        }
    }

    pub fn magnitude_db(&self, frequency: f64, sample_rate: f64) -> f64 {
        let coeff = self.normalized();
        let w = 2.0 * std::f64::consts::PI * frequency / sample_rate;
        let cos1 = w.cos();
        let sin1 = w.sin();
        let cos2 = (2.0 * w).cos();
        let sin2 = (2.0 * w).sin();

        let numerator_real = coeff.b0 + coeff.b1 * cos1 + coeff.b2 * cos2;
        let numerator_imag = -(coeff.b1 * sin1 + coeff.b2 * sin2);
        let denominator_real = 1.0 + coeff.a1 * cos1 + coeff.a2 * cos2;
        let denominator_imag = -(coeff.a1 * sin1 + coeff.a2 * sin2);

        let numerator = numerator_real.hypot(numerator_imag);
        let denominator = denominator_real.hypot(denominator_imag);
        if denominator == 0.0 {
            return 0.0;
        }
        20.0 * (numerator / denominator).log10()
    }
}

pub fn coefficients(band: &EqBand, sample_rate: f64) -> Biquad {
    let f0 = band
        .frequency
        .clamp(1.0, (sample_rate / 2.0 - 10.0).max(2.0));
    let q = band.q.clamp(0.05, 40.0);
    let gain = band.gain_db.clamp(-60.0, 60.0);

    let amplitude = 10f64.powf(gain / 40.0);
    let w0 = 2.0 * std::f64::consts::PI * f0 / sample_rate;
    let cos_w0 = w0.cos();
    let sin_w0 = w0.sin();
    let alpha = sin_w0 / (2.0 * q);
    let sqrt_a = amplitude.sqrt();

    match band.kind {
        BandType::LowShelf => Biquad {
            b0: amplitude * ((amplitude + 1.0) - (amplitude - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha),
            b1: 2.0 * amplitude * ((amplitude - 1.0) - (amplitude + 1.0) * cos_w0),
            b2: amplitude * ((amplitude + 1.0) - (amplitude - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha),
            a0: (amplitude + 1.0) + (amplitude - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha,
            a1: -2.0 * ((amplitude - 1.0) + (amplitude + 1.0) * cos_w0),
            a2: (amplitude + 1.0) + (amplitude - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha,
        },
        BandType::HighShelf => Biquad {
            b0: amplitude * ((amplitude + 1.0) + (amplitude - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha),
            b1: -2.0 * amplitude * ((amplitude - 1.0) + (amplitude + 1.0) * cos_w0),
            b2: amplitude * ((amplitude + 1.0) + (amplitude - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha),
            a0: (amplitude + 1.0) - (amplitude - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha,
            a1: 2.0 * ((amplitude - 1.0) - (amplitude + 1.0) * cos_w0),
            a2: (amplitude + 1.0) - (amplitude - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha,
        },
        BandType::LowPass => {
            let gain_factor = 10f64.powf(gain / 20.0);
            Biquad {
                b0: (1.0 - cos_w0) * 0.5 * gain_factor,
                b1: (1.0 - cos_w0) * gain_factor,
                b2: (1.0 - cos_w0) * 0.5 * gain_factor,
                a0: 1.0 + alpha,
                a1: -2.0 * cos_w0,
                a2: 1.0 - alpha,
            }
        }
        BandType::HighPass => {
            let gain_factor = 10f64.powf(gain / 20.0);
            Biquad {
                b0: (1.0 + cos_w0) * 0.5 * gain_factor,
                b1: -(1.0 + cos_w0) * gain_factor,
                b2: (1.0 + cos_w0) * 0.5 * gain_factor,
                a0: 1.0 + alpha,
                a1: -2.0 * cos_w0,
                a2: 1.0 - alpha,
            }
        }
        BandType::Notch => Biquad {
            b0: 1.0,
            b1: -2.0 * cos_w0,
            b2: 1.0,
            a0: 1.0 + alpha,
            a1: -2.0 * cos_w0,
            a2: 1.0 - alpha,
        },
        BandType::Bell => Biquad {
            b0: 1.0 + alpha * amplitude,
            b1: -2.0 * cos_w0,
            b2: 1.0 - alpha * amplitude,
            a0: 1.0 + alpha / amplitude,
            a1: -2.0 * cos_w0,
            a2: 1.0 - alpha / amplitude,
        },
    }
}

pub fn band_response_db(band: &EqBand, frequency: f64, sample_rate: f64) -> f64 {
    if !band.enabled {
        return 0.0;
    }
    coefficients(band, sample_rate).magnitude_db(frequency, sample_rate)
}

pub fn combined_response_db(bands: &[EqBand], frequency: f64, sample_rate: f64) -> f64 {
    bands
        .iter()
        .filter(|band| band.enabled)
        .map(|band| band_response_db(band, frequency, sample_rate))
        .sum()
}

/// Log-spaced response points suitable for an SVG path.
pub fn response_curve(bands: &[EqBand], points: usize, sample_rate: f64) -> Vec<(f64, f64)> {
    let points = points.max(2);
    (0..points)
        .map(|index| {
            let t = index as f64 / (points - 1) as f64;
            let frequency = 20.0 * (1000.0f64).powf(t); // 20 Hz .. 20 kHz
            (
                frequency,
                combined_response_db(bands, frequency, sample_rate),
            )
        })
        .collect()
}

pub fn default_bands() -> Vec<EqBand> {
    vec![
        EqBand::new(0, BandType::LowShelf, 90.0, 4.0, 0.70),
        EqBand::new(1, BandType::Bell, 640.0, 2.5, 1.20),
        EqBand::new(2, BandType::Bell, 3200.0, -2.0, 2.40),
        EqBand::new(3, BandType::HighShelf, 9000.0, 3.0, 0.70),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bell_at_center_equals_gain() {
        let band = EqBand::new(1, BandType::Bell, 640.0, 2.5, 1.2);
        let response = band_response_db(&band, 640.0, DEFAULT_SAMPLE_RATE);
        assert!((response - 2.5).abs() < 1e-6, "got {response}");
    }

    #[test]
    fn combined_response_sums_bands() {
        let bands = default_bands();
        let manual: f64 = bands
            .iter()
            .map(|band| band_response_db(band, 1000.0, DEFAULT_SAMPLE_RATE))
            .sum();
        let combined = combined_response_db(&bands, 1000.0, DEFAULT_SAMPLE_RATE);
        assert!((manual - combined).abs() < 1e-9);
    }

    #[test]
    fn bypassed_bands_are_flat() {
        let mut band = EqBand::new(0, BandType::Bell, 1000.0, 12.0, 1.0);
        band.enabled = false;
        assert_eq!(band_response_db(&band, 1000.0, DEFAULT_SAMPLE_RATE), 0.0);
    }

    #[test]
    fn parses_firmware_type_strings() {
        assert_eq!(BandType::parse("LPS"), BandType::LowShelf);
        assert_eq!(BandType::parse("high shelf"), BandType::HighShelf);
        assert_eq!(BandType::parse("BELL"), BandType::Bell);
        assert_eq!(BandType::parse(""), BandType::Bell);
    }

    #[test]
    fn curve_has_log_spacing() {
        let points = response_curve(&default_bands(), 5, DEFAULT_SAMPLE_RATE);
        assert_eq!(points.len(), 5);
        assert!((points[0].0 - 20.0).abs() < 1e-9);
        assert!((points[4].0 - 20_000.0).abs() < 1e-6);
        assert!((points[2].0 - 632.45).abs() < 1.0);
    }
}
