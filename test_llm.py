import json, time, urllib.request

MODELS = ["llama3.2:latest"]


SYSTEM = """You configure a browser cookie-consent tool. Decide which cookie categories to ALLOW (true) or BLOCK (false):
- functionality: preferences, language, UI settings, convenience features
- analytics: usage statistics and site performance measurement
- advertising: ad targeting, personalized ads, cross-site tracking
Strictly-necessary cookies are always allowed; do not output them.

Evaluate each of the three categories independently based on what the user
actually said. Do not assume a category is blocked just because another
category was mentioned or blocked.

Rules:
1. "Maximum privacy", "block everything", "block all", or any request to keep
   only what's required/necessary/essential means all three are false.
2. If the user wants personalized or relevant ads, advertising is true.
   This does not by itself say anything about functionality or analytics.
3. If the user says they accept or don't mind a category, that category is true.
4. If a category is not mentioned and not covered by rule 1, default it to
   false only if the overall request leans toward privacy; otherwise leave
   it true.
5. If the request is not about cookies or privacy, set understood=false and all three false.
6. If the request contradicts itself, set understood=false and describe the conflict in the explanation.
7. The explanation is one short sentence, specific to this request, that exactly matches the booleans you chose."""



SCHEMA = {"type": "object", "properties": {
    "understood": {"type": "boolean"},
    "functionality": {"type": "boolean"}, "analytics": {"type": "boolean"},
    "advertising": {"type": "boolean"}, "explanation": {"type": "string"}},
    "required": ["understood", "functionality", "analytics", "advertising", "explanation"]}

TESTS = [
    ("maximum privacy", "F,F,F"),
    ("I want personalized ads", "?,?,T"),
    ("block everything but let ads through", "u=False"),
    ("hello", "u=False"),
    ("what's the weather today", "u=False"),
    ("I'm fine with everything except ads", "T,T,F"),
    ("only keep what the site needs to work", "F,F,F"),
    ("ads that match my interests are fine", "?,?,T"),
    ("block ads but keep functionality", "T,?,F"),
    ("allow everything", "T,T,T"),
]

def ask(model, text):
    body = json.dumps({"model": model, "stream": False, "format": SCHEMA,
        "options": {"temperature": 0},
        "messages": [{"role": "system", "content": SYSTEM},
                     {"role": "user", "content": text}]}).encode()
    req = urllib.request.Request("http://localhost:11434/api/chat", body,
                                 {"Content-Type": "application/json"})
    t = time.time()
    out = json.loads(urllib.request.urlopen(req, timeout=300).read())
    return json.loads(out["message"]["content"]), time.time() - t

for model in MODELS:
    print(f"\n===== {model} =====")
    for text, expected in TESTS:
        for run in (1,):
            r, secs = ask(model, text)
            f = lambda b: "T" if b else "F"
            print(f"[{secs:5.1f}s] {text[:42]:42} exp={expected:14} "
                  f"got={f(r['functionality'])},{f(r['analytics'])},{f(r['advertising'])},u={f(r['understood'])} | {r['explanation']}")