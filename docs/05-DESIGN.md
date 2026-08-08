# C11 — Design system

Owner: Alfa (spec). Implementation: Taskforce (`web/src/**`). Nothing here deletes existing
code — every rule is satisfied by *changing values and adding primitives*, not by rewriting
screens.

Machine-checkable: `node tools/design-lint.mjs`. That command is the definition of "done",
the same way `forge test` is for the contracts. A design review that is only an opinion cannot
be re-run; this one can.

---

## The diagnosis, in numbers

The reference deck (Smorodina, 30+ screens) and our app differ in one measurable way before
any question of taste:

| Type size | Uses in `web/src` |
|---|---|
| `text-xs` | 100 |
| `text-sm` | 84 |
| `text-base` and larger | 26 |

**88% of all type sits in the two smallest sizes.** That is not a hierarchy — it is a wall.
When everything is small, nothing is emphasised, and the eye has no entry point. The reference
does the opposite: one enormous image, one bold price, one 2-line title, and every remaining
label shrunk to near-invisibility. It reads in half a second because 90% of it is *not asking
to be read*.

There is also no spacing scale, no radius scale, and no elevation model — only colour tokens.
So spacing is ad-hoc per component and nothing lines up between screens.

---

## Five principles, each with a test

**P1 · One primary action per screen.** The reference never shows two filled buttons. Ours
should not either — everything else is ghost, link, or icon.
*Test: at most one `.btn-primary` per route file.*

**P2 · Image/state before words.** The reference gives ~60% of every card to a photo. We have
no photos, so **status is our image**: a large coloured state block carries the meaning, and
prose only supports it.
*Test: every card component renders a visual state element before its first paragraph.*

**P3 · A real type scale, used sparsely.** Four sizes, not seven. Display for the one number
that matters, title for the name, body for the single supporting line, micro for labels.
*Test: `text-xs` must fall below 40% of type usage; display sizes must appear at least once
per screen.*

**P4 · An 8-point spacing scale.** Every gap is a multiple of 4, drawn from six tokens.
*Test: no arbitrary `p-[13px]`-style values; no raw pixel margins in className.*

**P5 · Prose is capped.** A card gets one supporting sentence. Explanations move to a detail
view or a disclosure.
*Test: no card component contains a text node longer than 120 characters.*

---

## Tokens

Added to `globals.css` alongside the existing colour tokens — nothing removed.

```css
/* type — four steps, not seven */
--text-display: 32px/1.1  700;   /* the one number that matters */
--text-title:   19px/1.3  600;   /* job or milestone name */
--text-body:    15px/1.5  400;   /* the single supporting line */
--text-micro:   12px/1.2  600;   /* labels, uppercase, tracked */

/* space — 8-point, six steps */
--space-1: 4px;   --space-2: 8px;   --space-3: 12px;
--space-4: 16px;  --space-6: 24px;  --space-8: 32px;

/* radius */
--radius-sm: 8px;  --radius-md: 12px;  --radius-lg: 16px;  --radius-pill: 999px;

/* elevation — dark UI uses borders, not shadows */
--elev-flat:  1px solid var(--mon-border);
--elev-raised:1px solid #2f2f36;

/* touch */
--tap-min: 44px;   /* nothing interactive smaller than this */
```

---

## Screen wireframes

Derived from the reference, mapped onto our domain. `▓` = dominant visual, `·` = micro label.

### Jobs list — the reference's product grid

The balance chip, filter row and 2-up card grid map directly. Status replaces the photo.

```
┌─────────────────────────────────┐
│ ◈ 2.4 MON        📍 testnet  🔍 │ ← chip row, micro type
├─────────────────────────────────┤
│ [ All ][ Client ][ Freelancer ] │ ← filter pills, horizontal scroll
├─────────────────────────────────┤
│ ┌─────────────┐ ┌─────────────┐ │
│ │▓▓▓▓▓▓▓▓▓▓▓▓▓│ │▓▓▓▓▓▓▓▓▓▓▓▓▓│ │ ← STATE BLOCK  ~96px
│ │▓ 1h 55m    ▓│ │▓ frozen    ▓│ │   colour = state, one line
│ │▓▓▓▓▓▓▓▓▓▓▓▓▓│ │▓▓▓▓▓▓▓▓▓▓▓▓▓│ │
│ │ Marketing   │ │ Brand       │ │ ← title, 2 lines max
│ │ site rebuild│ │ identity    │ │
│ │             │ │             │ │
│ │ 4.5 MON   → │ │ 2 MON     → │ │ ← DISPLAY type + chevron
│ └─────────────┘ └─────────────┘ │
├─────────────────────────────────┤
│  ⌂     ♡     ▤     ⬡     ◎      │ ← dock, icon + micro label
└─────────────────────────────────┘
```

Note what is *absent*: no milestone counts, no addresses, no explanatory sentence. Those live
one tap deeper. The card answers only "what is this, how much, what is happening".

### Job detail — the reference's product page

```
┌─────────────────────────────────┐
│ ‹                            ♡  │
├─────────────────────────────────┤
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
│▓                               ▓│ ← STATE HERO ~180px
│▓        1h 55m left            ▓│   the countdown IS the image
│▓    challenge window open      ▓│
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
├─────────────────────────────────┤
│ Marketing site rebuild          │ ← title
│ You are the client.             │ ← ONE supporting line
│                                 │
│  4.5      3       90s      2/3  │ ← the numbers row, display type
│  MON      milestones  window  done│  micro labels beneath
│  ·        ·        ·        ·   │
├─────────────────────────────────┤
│ ▸ Milestone 1   settled     ✓   │ ← collapsed rows,
│ ▾ Milestone 2   1h 55m left     │   only the open one expands
│     ┌─────────────────────────┐ │
│     │  Dispute this           │ │ ← ghost
│     └─────────────────────────┘ │
│ ▸ Milestone 3   not started     │
├─────────────────────────────────┤
│ ┌─────────────────────────────┐ │
│ │      Release 1.5 MON        │ │ ← THE one primary action
│ └─────────────────────────────┘ │
└─────────────────────────────────┘
```

The nutrition row in the reference (`240 ккал · 628 белки · 20 жиры`) is the model for the
numbers row. Big figure, tiny label, no sentence. It communicates five facts in the space a
sentence would use for one.

### Empty state — already close, needs less text

```
┌─────────────────────────────────┐
│                                 │
│              ▤                  │ ← icon 64px
│                                 │
│      No jobs yet                │ ← title
│      Fund one to begin.         │ ← ONE line, not three
│                                 │
│   ┌───────────────────────┐     │
│   │      Create a job     │     │ ← one primary
│   └───────────────────────┘     │
└─────────────────────────────────┘
```

### Settings — the reference's grouped list

```
┌─────────────────────────────────┐
│ ‹  Settings                     │
├─────────────────────────────────┤
│ ┌─────────────────────────────┐ │
│ │ Wallet          0x7c1d…  ›  │ │ ← 56px rows, chevron right
│ │ Network         Testnet  ›  │ │
│ │ Verifier        0x87B9…  ›  │ │
│ └─────────────────────────────┘ │
│ ┌─────────────────────────────┐ │
│ │ Notifications          ●──  │ │ ← toggle right-aligned
│ └─────────────────────────────┘ │
└─────────────────────────────────┘
```

---

## State colour, one meaning each

| State | Token | Where it appears |
|---|---|---|
| Pending | `--mon-muted` | grey block, no urgency |
| Submitted | `--mon-accent` | purple, awaiting the verifier |
| Attested | `--mon-warning` | amber, **the countdown is running** |
| Released | `--mon-success` | green, terminal |
| Disputed | `--mon-danger` | red, frozen |
| Refunded | `--mon-muted` | grey, terminal |

Amber is reserved exclusively for a live challenge window. If amber appears anywhere else the
one genuinely time-critical state stops being legible — which is the state the whole product
exists to make visible.

---

## What must not change

The empty-state honesty. "No escrow factory is configured, so nothing has been read from the
chain" is longer than this document's own rules would allow, and it stays: it distinguishes
*not asked* from *asked and empty*, and confusing those wastes somebody's afternoon. Design
rules serve comprehension; when they collide with it, comprehension wins. P5 exempts empty
states for exactly this reason.
