import Groq from 'groq-sdk';
import { CONFIG } from '../config';

const groq = new Groq({
  apiKey: CONFIG.GROQ_API_KEY,
});

export async function verifyScreenshot(imageUrl: string, gameName: string): Promise<{ isValid: boolean, reasoning: string }> {
  if (!CONFIG.GROQ_API_KEY) {
    console.warn('GROQ_API_KEY NOT CONFIGURED. Verification protocol bypassed.');
    return { isValid: true, reasoning: 'Denuvo Protocol Bypass: Key not configured.' };
  }

  try {
    const response = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are a highly precise security auditor specialized in Denuvo activation compliance. Your task is to verify screenshots based on strict protocol requirements.'
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `VERIFICATION PROTOCOL:
Target Game: "${gameName}"

REQUIREMENTS:
A compliant screenshot MUST contain the following three windows simultaneously:
1. FILE EXPLORER: Must show a directory path or folder name matching "${gameName}". Accept close matches and abbreviations.
2. WINDOWS UPDATE BLOCKER (WUB): Must show "Disable Updates" as the active state (Green shield, checkmark, or selected radio button).
3. PROPERTIES WINDOW: A folder or EXE properties window related to the game.

INSTRUCTIONS:
- Analyze the image carefully for these three elements.
- Verify that Windows updates are actually disabled in the WUB window.
- Check that the file path is clearly visible and belongs to "${gameName}".
- Be intelligent about regional titles (e.g. Biohazard for Resident Evil).

OUTPUT FORMAT:
REASONING: [Explain your findings for each requirement]
ANSWER: [YES or NO]`,
            },
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
              },
            },
          ],
        },
      ],
      // Model can be overridden via env var if Groq deprecates the default.
      // List of models: https://console.groq.com/docs/models
      model: process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
      temperature: 0.1, // Low temperature for higher consistency
    });

    const rawResult = response.choices[0]?.message?.content?.trim() || "";
    console.log(`[Groq Verification] Processed response: "${rawResult}"`);

    // Robust parsing for both ANSWER and REASONING
    const answerMatch = rawResult.match(/ANSWER:\s*(YES|NO)/i);
    const reasoningMatch = rawResult.match(/REASONING:\s*([\s\S]*?)(?=ANSWER:|$)/i);

    let isValid = false;
    if (answerMatch) {
      isValid = answerMatch[1].toUpperCase() === 'YES';
    } else {
      // Fallback if ANSWER tag is missing but YES is present in the text
      isValid = rawResult.toUpperCase().includes('ANSWER: YES') || 
                (rawResult.toUpperCase().includes('YES') && !rawResult.toUpperCase().includes('NO'));
    }

    const reasoning = reasoningMatch 
      ? reasoningMatch[1].trim() 
      : (rawResult.length > 0 ? rawResult.substring(0, 100) : "Analysis complete.");

    return { isValid, reasoning };
  } catch (error) {
    console.error('Error verifying screenshot with Groq:', error);
    return { isValid: false, reasoning: 'Vision system temporarily unavailable.' };
  }
}

