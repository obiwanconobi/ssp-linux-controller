//! Friendly labels and knob assignment priorities.

use crate::node::Node;
use crate::path_name;

pub fn block_label(path: &str, node: Option<&Node>) -> String {
    let name = path_name(path);
    if let Some(label) = label_for(name) {
        return label.to_string();
    }
    if let Some(node) = node {
        let desc = node.desc().trim();
        if !desc.is_empty() {
            return desc.to_string();
        }
    }
    let pretty = name.replace('_', " ");
    if pretty.is_empty() {
        path.to_string()
    } else {
        title_case(&pretty)
    }
}

pub fn label_for(name: &str) -> Option<&'static str> {
    Some(match name {
        "gate" => "Noise Gate",
        "pitch" => "Pitch",
        "pitch_time" => "Pitch (Time)",
        "exp" => "Expression",
        "comp" => "Compressor",
        "dyna_comp" => "Compressor (Dyna)",
        "mod_pre" => "Modulation (pre)",
        "drive" => "Drive / Distortion",
        "amp" => "Amp (NAM)",
        "ir" => "IR / Cabinet",
        "eq" => "EQ",
        "eq2" => "EQ 2",
        "parametric_eq" => "Parametric EQ",
        "crossover" => "Crossover",
        "mod" => "Modulation (post)",
        "chorus" => "Chorus",
        "flanger" => "Flanger",
        "rotary" => "Rotary",
        "pickup" => "Pickup",
        "dtchr" => "Detuner",
        "pcm42" => "PCM 42",
        "delay" | "delay2" => "Delay",
        "reverb" | "reverb2" => "Reverb",
        _ => return None,
    })
}

fn title_case(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut start = true;
    for character in text.chars() {
        if start {
            out.extend(character.to_uppercase());
            start = false;
        } else {
            out.push(character);
        }
        if character == ' ' {
            start = true;
        }
    }
    out
}

/// Family used by the shell knob mapping and theme chassis colours.
pub fn block_family(item_name: &str) -> &'static str {
    match item_name {
        "drive" | "dtchr" | "pcm42" => "drive",
        "amp" => "amp",
        "ir" => "cab",
        "comp" | "dyna_comp" => "comp",
        "gate" | "exp" | "pitch" | "pitch_time" | "pickup" => "utility",
        "delay" | "delay2" => "delay",
        "reverb" | "reverb2" => "reverb",
        "mod" | "mod_pre" | "chorus" | "flanger" | "rotary" => "mod",
        "eq" | "eq2" | "parametric_eq" | "crossover" => "utility",
        _ => "utility",
    }
}

/// Authored priority table: the parameters a player reaches for first.
pub fn knob_priority(family: &str) -> &'static [&'static str] {
    match family {
        "drive" => &["gain", "treble", "lvl", "mid", "low", "mix"],
        "amp" => &["gain", "low", "treble", "mid", "lvl", "vol"],
        "comp" => &["thresh", "ratio", "lvl", "attack", "release"],
        "gate" => &["thresh", "decay", "attack", "hold"],
        "delay" => &["dlytime", "fdbk", "mix", "level"],
        "reverb" => &["mix", "decay", "predelay", "lvl"],
        "mod" => &["rate", "depth", "mix"],
        "cab" => &["lvl", "blend", "locut", "hicut"],
        _ => &[],
    }
}

/// Normalized label aliases for alternate firmware spellings.
pub fn label_alias(name: &str) -> &str {
    match name {
        "gain" | "drive" => "Gain",
        "treble" | "high" | "tone" | "hf" => "Tone",
        "lvl" | "level" | "volume" | "vol" => "Volume",
        "mid" | "middle" => "Mid",
        "low" | "bass" => "Bass",
        "fdbk" | "feedback" => "Feedback",
        "mix" | "blend" => "Mix",
        "dlytime" | "time" | "delay" => "Time",
        "thresh" | "threshold" => "Threshold",
        "ratio" => "Ratio",
        "attack" => "Attack",
        "release" => "Release",
        "decay" => "Decay",
        "predelay" => "Pre-delay",
        "rate" => "Rate",
        "depth" => "Depth",
        "locut" => "Low cut",
        "hicut" => "High cut",
        "pan" | "pan1" => "Pan",
        "q" => "Q",
        "freq" | "frequency" => "Frequency",
        other => other,
    }
}

/// Which parameters a pedal shell shows (at most three).
pub fn shell_knob_names(family: &str) -> &'static [&'static str] {
    match family {
        "drive" => &["gain", "treble", "lvl"],
        "amp" => &["gain", "low", "treble"],
        "comp" => &["thresh", "ratio", "lvl"],
        "gate" => &["thresh", "decay"],
        "delay" => &["dlytime", "fdbk", "mix"],
        "reverb" => &["mix", "decay", "predelay"],
        "mod" => &["rate", "depth", "mix"],
        "cab" => &["lvl", "blend", "locut"],
        _ => &[],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_match_python_defaults() {
        assert_eq!(block_label(r"root\app\amp", None), "Amp (NAM)");
        assert_eq!(block_label(r"root\app\delay2", None), "Delay");
        assert_eq!(block_label(r"root\app\foo_bar", None), "Foo Bar");
    }

    #[test]
    fn two_knob_families_do_not_pad() {
        assert_eq!(shell_knob_names("gate").len(), 2);
    }
}
