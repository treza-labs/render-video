# Treza Render Video

A GitHub Action that renders an AI video or image with [Treza](https://www.trezalabs.com), or runs one of your saved Treza pipelines, from a workflow step. Treza prices the render first, and the step stops before anything starts if the price is over the cap you set.

![Treza demo](https://raw.githubusercontent.com/treza-labs/treza-labs/main/assets/treza-demo.gif)

Some things it is used for:

- a short clip for every release, attached to the release
- a weekly Short from a schedule, made by a saved pipeline
- a header image for every blog post pull request

## Quick start

```yaml
- uses: treza-labs/render-video@v1
  id: clip
  with:
    api-key: ${{ secrets.TREZA_API_KEY }}
    prompt: A paper boat drifting across a pond at sunrise, slow push-in
    aspect-ratio: "9:16"
    duration: "4"
    max-cost-usd: "1.00"
    download-path: out/

- name: Show what it made
  env:
    URL: ${{ steps.clip.outputs.url }}
    PRICE: ${{ steps.clip.outputs.price-usd }}
  run: echo "Made $URL for $PRICE USD"
```

The step waits for the render (one to five minutes for most clips), sets the outputs, saves the file and writes a job summary with the price, the status and links. Image results are shown in the summary.

## Get a key

1. Create a Treza account at https://www.trezalabs.com and add credits. Renders are paid from prepaid credits; there is no subscription and the action itself is free.
2. Make an API key at https://www.trezalabs.com/platform/api-keys with the `pipelines:read`, `pipelines:write` and `pipelines:run` permissions.
3. Add it to your repository as a secret named `TREZA_API_KEY`: Settings, Secrets and variables, Actions, New repository secret. Or from a terminal: `gh secret set TREZA_API_KEY`.

Pass it with `api-key: ${{ secrets.TREZA_API_KEY }}`. Never write the key into a workflow file.

## Examples

### A clip for every release

```yaml
name: Release clip
on:
  release:
    types: [published]

permissions:
  contents: write # to attach the clip to the release

jobs:
  clip:
    runs-on: ubuntu-latest
    steps:
      - uses: treza-labs/render-video@v1
        id: clip
        with:
          api-key: ${{ secrets.TREZA_API_KEY }}
          prompt: >-
            A short teaser for ${{ github.event.repository.name }} ${{ github.event.release.tag_name }},
            "${{ github.event.release.name }}". Clean motion graphics on a dark background, slow camera move.
          aspect-ratio: "16:9"
          duration: "6"
          max-cost-usd: "1.50"
          download-path: release-clip.mp4

      - name: Attach it to the release
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.event.release.tag_name }}
        run: gh release upload "$TAG" release-clip.mp4 --repo "$GITHUB_REPOSITORY"
```

### A weekly Short from a saved pipeline

Build the pipeline once in Treza (script, clips, voice, captions, music), then run it on a schedule with new inputs. `pipeline-id` is in the pipeline's address in Treza. `inputs` is keyed by the pipeline's input steps; steps you leave out run with what is saved in the pipeline.

```yaml
name: Weekly Short
on:
  schedule:
    - cron: "17 15 * * 1" # Mondays, 15:17 UTC
  workflow_dispatch:

jobs:
  short:
    runs-on: ubuntu-latest
    steps:
      - uses: treza-labs/render-video@v1
        id: short
        with:
          api-key: ${{ secrets.TREZA_API_KEY }}
          mode: pipeline
          pipeline-id: pipeline_1790000000000_example
          inputs: '{"prompt_1": "Three things we shipped this week"}'
          max-cost-usd: "3.00"
          timeout-minutes: "30"
          download-path: short/

      - uses: actions/upload-artifact@v4
        with:
          name: weekly-short
          path: short/
```

To put text from the event into `inputs`, wrap it in `toJSON` so quotes and line breaks stay valid JSON:

```yaml
inputs: '{"prompt_1": ${{ toJSON(github.event.head_commit.message) }}}'
```

### A header image for every blog post pull request

```yaml
name: Post header
on:
  pull_request:
    types: [opened]
    paths: ["content/blog/**"]

permissions:
  pull-requests: write

jobs:
  header:
    # Pull requests from forks get no secrets, so they are skipped.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: treza-labs/render-video@v1
        id: header
        with:
          api-key: ${{ secrets.TREZA_API_KEY }}
          mode: image
          prompt: "Header illustration for a blog post titled: ${{ github.event.pull_request.title }}. Flat shapes, warm colours, no text."
          aspect-ratio: "16:9"
          max-cost-usd: "0.25"

      - name: Comment with the picture
        env:
          GH_TOKEN: ${{ github.token }}
          URL: ${{ steps.header.outputs.url }}
          PR: ${{ github.event.pull_request.number }}
        run: gh pr comment "$PR" --repo "$GITHUB_REPOSITORY" --body "Suggested header: ![header]($URL)"
```

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `api-key` | required | Your Treza API key, from a secret. |
| `mode` | `video` | `video` (a clip from `prompt`), `image` (a picture from `prompt`) or `pipeline` (run a saved pipeline). |
| `prompt` | | `video` and `image`: what the clip or picture shows. Up to 2000 characters. |
| `model` | Treza's default | `video` and `image`: a Treza model ID. Video defaults to Veo 3.1 Lite, images to Nano Banana. |
| `duration` | `4` | `video`: length in seconds, 1 to 60. A model with fixed lengths renders the next one up and the log says so. |
| `aspect-ratio` | `16:9` | `video`: `16:9`, `9:16` (Shorts, Reels, TikTok) or `1:1`. `image`: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9` or `21:9`; left empty, the model chooses. |
| `pipeline-id` | | `pipeline`: the pipeline's ID, starting with `pipeline_`. |
| `inputs` | | `pipeline`: a JSON object keyed by input step, like `{"prompt_1": "a lighthouse at dawn"}`. |
| `max-cost-usd` | required for `video` and `pipeline` | The most this run may cost, in US dollars. Optional for `image`. |
| `wait` | `true` | Wait for the render. With `false` the step ends once the render has started, with `status` `running`. |
| `timeout-minutes` | `15` | How long to wait. If the render is still going, the step fails and the render carries on in Treza. |
| `download-path` | | Save the first file here, relative to the workspace. A path ending in `/`, or an existing folder, keeps the file's own name. |

## Outputs

| Output | Meaning |
| --- | --- |
| `run-id` | The Treza run ID. |
| `pipeline-id` | The pipeline the run belongs to. Video and image renders get one each. |
| `status` | `success`, `partial`, `error`, `cancelled`, `running` (with `wait: false`, or after a timeout), `not-started` (refused before anything started) or `unknown` (Treza did not confirm the start). |
| `price-usd` | The quoted price, like `0.28`. `0.00` for a free image. |
| `url` | The first file: the clip in `video` mode, the picture in `image` mode, the first file a pipeline returned. |
| `files` | Every file URL the run returned, as a JSON array. Read it with `fromJSON(steps.<id>.outputs.files)`. |
| `path` | Where `download-path` saved the file, as an absolute path. |

A run that finishes with `partial` (some steps did not finish) passes with a warning. `error` and `cancelled` fail the step with Treza's reason.

## Cost and safety

- **Priced first.** Every run is quoted before it starts. The log and the job summary show the price.
- **A cap you set.** `max-cost-usd` is required for video and pipeline runs, so a workflow can never spend without a limit. If the quote is higher, the step fails, nothing starts and nothing is charged. For images the cap is optional; set it if you name a more expensive image model.
- **The balance is checked too.** If your credits do not cover the quote, the step fails with the price, the balance and where to add credits. Nothing is charged.
- **Started once.** The render is started with the quote's ID, in one call that is never repeated. If that call gets no answer, the step fails and says the render may have started, so you can check in Treza before running it again.
- **Re-running costs again.** Re-running a workflow, or a schedule firing again, makes a new render with a new quote and a new charge.
- **Timeouts and cancelled workflows do not stop the render.** It finishes in Treza, is charged as quoted, and the file lands in your Treza library.
- **Who can spend.** Anyone who can trigger the workflow can spend up to `max-cost-usd` per run. Workflows started from forks get no secrets, so they cannot render.
- **The key.** It is masked in the logs and sent only to `www.trezalabs.com` over HTTPS. The finished file is downloaded from its signed link without the key.
- **The links.** File URLs are signed links: anyone who has one can open the file. In a public repository, the logs and the job summary are public too.
- **Pin a version.** Use `treza-labs/render-video@v1`, or a full commit SHA if your policy asks for one.

## Other ways to use Treza

The same renders are available from n8n, Zapier, Dify, ComfyUI, LangChain, the Vercel AI SDK and more: https://www.trezalabs.com/integrations

## Development

```bash
npm ci
npm test          # unit tests against a scripted Treza, then dist/index.js end to end against a local stand-in
npm run build     # bundle src/ into dist/index.js; commit dist/ with the change
```

`test/mock-treza.mjs` is the stand-in for Treza's API. The workflow in `.github/workflows/test.yml` also runs the action itself (`uses: ./`) against it.

## Support

Issues: https://github.com/treza-labs/render-video/issues · Email: hello@trezalabs.com

MIT licensed. Copyright 2026 Treza Labs, Inc.
