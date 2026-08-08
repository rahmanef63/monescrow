# MonEscrow visual assets

This folder is the production asset set for the MonEscrow hackathon build.

## Brand master

- `brand/logo.svg` - header wordmark on transparent background
- `brand/logo-mark.svg` - square vector mark; progress-lock concept
- `brand/favicon.png` - 512 x 512 transparent favicon source

The logo mark is a lock whose body is a segmented milestone progress bar. Purple segments represent locked/in-progress value; the mint segment represents verified/releasable progress.

## Social

- `social/og.png` - 1200 x 630 Open Graph image, optimized for Discord embeds

## Empty states

- `empty/no-jobs.png` - 800 x 600 transparent illustration
- `empty/awaiting-freelancer.png` - 800 x 600 transparent illustration

Both illustrations are designed to sit directly on `#09090b`. They intentionally contain no baked-in UI copy.

## Pitch deck

- `deck/01-title.png`
- `deck/02-problem.png`
- `deck/03-mechanism.png`
- `deck/04-challenge-window.png`
- `deck/05-product-flow.png`
- `deck/06-trust-boundaries.png`
- `deck/07-why-monad.png`
- `deck/08-product-states.png`
- `deck/09-close.png`
- `deck/MonEscrow-Pitch.html` - animated seven-slide live pitch; all runtime assets are colocated in `deck/`
- `deck/logo.svg` - local deck wordmark copy
- `deck/logo-mark.svg` - local deck mark copy
- `deck/three-phone-demo.png` - local deck UI mockup copy

Every deck image is 1920 x 1080.

## Visual rules

- Background: `#09090b`
- Surface: `#18181b`
- Border: `#27272a`
- Primary text: `#f4f4f5`
- Secondary text: `#a1a1aa`
- Monad/action purple: `#836EF9`
- Released/pass: `#34d399`
- Challenge window: `#fbbf24`
- Disputed/fail: `#f87171`
- Typeface: system UI stack only

Status color always accompanies explicit language. Warning means a live challenge window, not generic danger. Red is reserved for failed or disputed states. No coins, rockets, handshakes, gold, or casino imagery.

## Try-it placeholder and motion handoff

- `placeholder/try-monescrow.png` - 1600 x 900 opening placeholder
- `placeholder/try-monescrow.webp` - compressed WebP equivalent
- `placeholder/try-monescrow-graphic.png` - 1200 x 600 transparent challenge-frame graphic
- `placeholder/try-monescrow-graphic.webp` - lossless transparent WebP equivalent
- `placeholder/progress-lock-spritesheet.png` - 7200 x 600 transparent six-frame strip
- `placeholder/progress-lock-spritesheet.webp` - lossless WebP strip
- `placeholder/progress-lock-animated.webp` - looping animated preview
- `placeholder/frames/progress-lock-01..06.png` - individual transparent PNG frames
- `placeholder/frames/progress-lock-01..06.webp` - individual lossless WebP frames

Recommended sequence:

1. Open - 500 ms
2. Submitted - 500 ms
3. Verified - 650 ms
4. Challenge-window pulse - 650 ms
5. Released - 500 ms
6. Complete - 1300 ms

Keep all frames on the same 1200 x 600 canvas. Animate with opacity cuts for reliability, or interpolate the lock shackle and progress colors in the frontend. Respect `prefers-reduced-motion` by showing `try-monescrow-graphic` instead of the loop.
