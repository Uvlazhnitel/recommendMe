// Historical audit fixtures stay frozen. Undo only the explicitly approved language
// sentence when comparing against their wire hashes; all other bytes must match.
export function beforeRussianLanguage(input: unknown) {
  if (!Array.isArray(input)) return input;
  return input.map((message, index) => index === 0 && typeof message.content === 'string' ? { ...message,
    content: message.content.replace('Write both why_fit and possible_mismatch in natural Russian, including uncertainty and risk statements, and return only the specified JSON. Preserve official movie titles and proper names when no verified Russian name is supplied.', 'Write explanations in English and return only the specified JSON.'),
  } : message);
}
