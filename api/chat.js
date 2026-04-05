export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { question, data } = req.body;
    if (!question) return res.status(400).json({ error: 'No question provided' });
    if (!data)     return res.status(400).json({ error: 'No data provided' });

    const key = process.env.ANTHROPIC_KEY;
    if (!key) return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });

    const prompt = `You are the data analyst for Prana Wellness Club, a boutique fitness studio in Austin.
You have access to this week's Founder Member data. Answer the question below directly and concisely.
Only reference Founder Members. Be specific — use real names, numbers, and dates from the data.

CURRENT WEEK DATA:
${JSON.stringify(data)}

QUESTION: ${question}

Answer in 2-5 sentences maximum. Be direct. Use real names and numbers from the data.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const claude = await response.json();
    if (!claude.content || !claude.content[0]) {
      return res.status(500).json({ error: 'No response from Claude' });
    }

    return res.status(200).json({ answer: claude.content[0].text });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
