# PsychMem

> **⚠️ This package is no longer maintained and should not be used.**
>
> After extensive exploration, we concluded that persistent AI memory cannot be solved correctly at the plugin/hook layer. Plugin systems expose only coarse lifecycle events, lack access to underlying session storage, and can only inject context through hacks that pollute conversation history. True memory for AI requires infrastructure-level access — sitting between the user and the model, not bolted on top.
>
> **This work continues properly in [DaySee](#daysee).**

---

## What We Learned

PsychMem was an attempt to give AI coding agents (OpenCode, Claude Code) persistent memory modelled on cognitive science — dual-store STM/LTM, Ebbinghaus decay curves, BM25 retrieval, psychology-grounded importance scoring.

The memory model itself is sound. The architecture is wrong.

The fundamental problem: OpenCode's plugin API gives you `session.created`, `session.idle`, `session.deleted`, and `experimental.session.compacting`. That's it. You can't intercept individual messages at the model level, you don't have access to how context is assembled per request, and the only way to inject memories is via a fake user message with `noReply: true` — which pollutes the conversation history and is not how memory should work.

Every version of PsychMem hit the same ceiling. We rewrote the storage layer (SQLite → markdown vault), rewrote the write strategy (per-message → per-session), rewrote the retrieval (Jaccard similarity → BM25+), and the core limitation remained: **plugin hooks are the wrong abstraction for memory**.

---

## DaySee

This work continues in **DaySee** — a project building memory at the infrastructure layer, where it actually belongs.

[![Watch the beta demo](#)](#)

<!-- Replace # with the actual video URL when available -->

DaySee sits at the model layer rather than the plugin layer, giving it the access required to build memory that actually works across sessions, models, and tools.

---

## Original Concept

The original PsychMem concept — psychology-grounded selective memory with decay, consolidation, and scoped injection — remains the design goal. The research references below informed the model:

1. **Atkinson & Shiffrin** (1968) — Dual-store model (STM/LTM)
2. **Ebbinghaus** (1885) — Forgetting curves
3. **Miller** (1956) — Working memory limits (7 ± 2)
4. **Cowan** (2001) — Updated working memory capacity model
5. **Nader et al.** (2000) — Memory reconsolidation
6. **McGaugh** (2000) — Memory consolidation
7. **Craik & Lockhart** (1972) — Levels of processing
8. **Anderson & Schooler** (1991) — Environmental reflections in memory

---

## License

MIT
