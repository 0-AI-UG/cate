# Jev browser test prompts

Run commands in a Cate terminal. Enable **Browser Read and Control** in **Settings → CLI** first.

Jev selects one whitespace-separated word from your prompt for each text field. Punctuation is preserved, so write the intended value as a standalone word. Include destination URLs explicitly.

## 1. Save your OpenRouter key in Cate

Open **Settings → CLI → OpenRouter API key**, paste your key, and press Enter or leave the field to save it. Enable **Browser Read** and **Browser Control** in the same settings. No environment export is needed. Clearing the key disables Jev.

## 2. Select a browser panel

List your panels:

```bash
cate panel list
```

Replace `BROWSER_PANEL_ID` with the ID of a **browser** panel, then run:

```bash
cate panel set BROWSER_PANEL_ID
```

If you need a browser panel, create one, then list and select it using the commands above:

```bash
cate browser run 'var testTab = await cua.createBrowserTab("about:blank", {newPanel:true});'
```

## 3. Simple navigation

```bash
cate browser jev 'Go to https://example.com and finish when the Example Domain heading is visible.' --max-steps 5
```

## 4. Wikipedia in one prompt

This workflow was verified live. `Berlin` is the single word selected for the search field.

```bash
cate browser jev 'Go to https://www.wikipedia.org and search for Berlin then submit the search. Finish when the Berlin article heading is visible.' --max-steps 15
```

## 5. Wikipedia in separate steps

Open the search page:

```bash
cate browser jev 'Go to https://www.wikipedia.org and finish when the Wikipedia search field is visible.' --max-steps 5
```

Then search and open the article:

```bash
cate browser jev 'Search Wikipedia for Berlin then submit the search. Finish when the Berlin article heading is visible.' --max-steps 10
```

## 6. Another search with JSON output

This is an additional prompt to try; public-page navigation can stop if Jev is uncertain.

```bash
cate browser jev 'Go to https://www.wikipedia.org and search for Mars then open the planet article. Finish when its article heading is visible.' --max-steps 15 --json
```

## 7. Local form tests

Create the test form first. This setup uses JavaScript mode; the following commands use Jev.

```bash
cate browser run 'var formTab = await cua.createBrowserTab("data:text/html," + encodeURIComponent(`<title>Jev test form</title><label>Greeting <input id="greeting"></label><button onclick="document.getElementById(&quot;result&quot;).textContent=&quot;Saved greeting: &quot;+document.getElementById(&quot;greeting&quot;).value">Save</button><p id="result">Not saved yet</p>`));'
```

Select `Hi` from the prompt and save:

```bash
cate browser jev 'Set the Greeting field to Hi and click Save. Finish when the page says Saved greeting: Hi' --max-steps 5
```

Preserve punctuation by selecting `Hello!`:

```bash
cate browser jev 'Set Greeting to Hello! then click Save. Finish when the saved greeting shows Hello!' --max-steps 5 --json
```

Replace the existing value with `Hello`:

```bash
cate browser jev 'Replace the Greeting field with Hello and click Save. Finish when the page says Saved greeting: Hello' --max-steps 5
```

## 8. User takeover

With the local form still open, run this and immediately click or type inside the browser while Jev is choosing an action or word. If your input arrives before the run finishes, it should stop with `browser-action-preempted-by-user`.

```bash
cate browser jev 'Replace Greeting with Goodbye and click Save. Finish when the saved greeting shows Goodbye' --max-steps 5
```

## Notes

- Each run uses the selected browser panel's active tab, then stays bound to that tab.
- Avoid interacting with the browser during a normal run; user input stops Jev.
- Each field value must be one word from the prompt. Multiword values and generated text are unsupported.
- `--max-steps` counts browser steps, not model calls.
- Runs have a 180-second timeout; prompts can contain up to 8,000 characters.
- Only `done` exits with code 0. `--json` includes the status, actions, and model-call count.
- If Jev reports `uncertain` or `blocked`, try a shorter prompt with one clear outcome.
