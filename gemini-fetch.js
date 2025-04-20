// gemini-fetch.js
async function generateContentWithFetch(apiKey, prompt) {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not provided.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-001:generateContent?key=${apiKey}`;

  const data = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 2048,
    },
  };

  try {
    console.log("Sending request to Gemini API...");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        `HTTP error! status: ${response.status}, details: ${JSON.stringify(errorData)}`
      );
    }

    const result = await response.json();
    const rawText = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) throw new Error("No text returned by Gemini.");

    console.log("Raw Gemini response:", rawText);

    // Remove markdown-style code block ```json ... ```
    const cleanedText = rawText.replace(/```json\s*([\s\S]*?)\s*```/, "$1").trim();
    const parsed = JSON.parse(cleanedText);

    // Convert Gemini JSON to expected format
    return {
      ingredients: parsed.ingredients?.map(i => i.name) || [],
      instructions: (parsed.ingredients || []).reduce((acc, item) => {
        acc[item.name] = item.howToUse || "No specific instruction.";
        return acc;
      }, {}),
      washFrequency: parsed.washFrequency || "Not specified",
      tips: parsed.tips || [],
      resources: parsed.resources || [],
    };
  } catch (error) {
    console.error("Gemini Fetch Error:", error);
    return {
      error: "Could not parse Gemini response as JSON.",
      rawResponse: error.message,
    };
  }
}

async function generateCarePlanFetch(surveyData, apiKey) {
  const prompt = `
You are a professional hair care specialist. Based on the following survey responses, generate a JSON response like this:

\`\`\`json
{
  "ingredients": [
    { "name": "Ingredient 1", "howToUse": "Instructions for Ingredient 1" }
  ],
  "washFrequency": "e.g., Twice a week",
  "tips": ["Tip 1", "Tip 2"],
  "resources": [{"name": "Site Name", "type": "Website"}]
}
\`\`\`

Survey:
- Hair Type: ${surveyData.hairType}
- Hair Texture: ${surveyData.hairTexture}
- Hair Porosity: ${surveyData.porosity}
- Scalp Condition: ${surveyData.scalpCondition}
- Product Use: ${surveyData.productUse}
- Styling Habits: ${surveyData.stylingHabits}
- Hair Goals: ${surveyData.hairGoals}
- Lifestyle: ${surveyData.lifestyle}
`;

  return await generateContentWithFetch(apiKey, prompt);
}

module.exports = { generateCarePlanFetch };
