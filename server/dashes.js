// =========================================================================
// Em-dash scrub for AI-written copy. The prompts already tell the model not to
// use em dashes; this is the guarantee, run on every generated post and idea
// before it leaves the server, because models slip back into them anyway.
//
// Each em dash is swapped for the punctuation it was standing in for:
//   at the start of a line (attribution, list marker)   -> "- "
//   between two numbers (a range like 2019-2024)        -> "-"
//   at the end of a line or next to other punctuation   -> dropped
//   anywhere else (a pause or an aside)                 -> ", "
// A spaced en dash is the same pause in disguise, so it is treated as an em
// dash. Unspaced en dashes ("9-5" style ranges) are left alone.
// =========================================================================

export function stripEmDashes(text) {
  return String(text ?? '')
    .replace(/(^|[ \t])\u2013(?=[ \t])/gm, '$1\u2014')
    .replace(/^([ \t]*)\u2014[ \t]*/gm, '$1- ')
    .replace(/(\d)[ \t]*\u2014[ \t]*(?=\d)/g, '$1-')
    .replace(/[ \t]*\u2014[ \t]*(?=$|[.,;:!?)\]"'\u201d\u2019])/gm, '')
    .replace(/([.,;:!?])[ \t]*\u2014[ \t]*/g, '$1 ')
    .replace(/[ \t]*\u2014[ \t]*/g, ', ')
}
