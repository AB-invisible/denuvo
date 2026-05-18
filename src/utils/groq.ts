import Groq from 'groq-sdk';
import { CONFIG } from '../config';

const groq = new Groq({
  apiKey: CONFIG.GROQ_API_KEY,
});

/**
 * Special reasoning string returned when verification was skipped because
 * GROQ_API_KEY isn't set. The auto-gen flow in index.ts detects this exact
 * string and routes the ticket to manual staff delivery instead of
 * auto-generating a token off an unverified screenshot.
 */
export const VERIFY_BYPASS_REASON = '__GROQ_NOT_CONFIGURED__';

export async function verifyScreenshot(imageUrl: string, gameName: string): Promise<{ isValid: boolean, reasoning: string }> {
  if (!CONFIG.GROQ_API_KEY) {
    console.warn('[Groq] GROQ_API_KEY NOT CONFIGURED — screenshot bypassed for verification, manual staff delivery required.');
    // isValid=true so the UI shows "received" (we don't want to falsely fail
    // the user), but reasoning carries a sentinel that index.ts uses to skip
    // auto-generation and require manual staff delivery instead.
    return { isValid: true, reasoning: VERIFY_BYPASS_REASON };
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

1. FILE EXPLORER: Must show a directory path or folder name matching
   "${gameName}". Accept close matches, regional titles (e.g. Biohazard
   for Resident Evil), abbreviations, and project codenames.

2. WINDOWS UPDATE BLOCKER (WUB): Must show Windows Update SERVICE is
   currently DISABLED / STOPPED. The DEFINITIVE indicator is the large
   status shield / icon under "Stato Servizi" / "Service Status" in
   the bottom-right of the WUB window. The shield reflects the
   CURRENT runtime state of the Windows Update service:
     ✅ COMPLIANT → shield is RED (or red with an X / red cross).
        Red = Windows Update service has been STOPPED by WUB = updates
        cannot run = exactly what we want.
     ❌ NON-COMPLIANT → shield is GREEN (or green with a checkmark).
        Green = Windows Update service is RUNNING = the user hasn't
        actually clicked "Apply" with the Disable option, OR they
        re-enabled it = updates can flow = NOT compliant.

   DO NOT rely on radio button labels — the app is localized
   (English, Italian "Abilita/Disabilita", Spanish, Portuguese, etc.)
   AND the radio buttons show what the user INTENDS to do, not what's
   currently active. Only the shield color tells you the live state.

   Common confusion: a user might select the "Disable Service" radio
   button but NOT click "Apply" — radio shows correct intent, but
   shield is still green (service still running) → NOT compliant.

3. PROPERTIES WINDOW: A folder or EXE properties window related to the
   game (file size, attributes, type, etc.).

INSTRUCTIONS:
- Analyze the image carefully for these three elements.
- For WUB, examine the icon color, not the text labels.
- For File Explorer, accept partial matches and codenames.
- All three windows must be VISIBLE in the same screenshot.

OUTPUT FORMAT:
REASONING: [Explain your findings for each requirement; for WUB, name the shield color you see]
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

