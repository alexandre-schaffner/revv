-- Decode HTML entities left in the three agent-authored columns the UI renders
-- as plain text. Agents intermittently write `Context &amp; design decisions`
-- into a chapter title; Svelte escapes the stored string a second time, so the
-- reader sees the literal `&amp;` in the chapter header.
--
-- `providers/agent-text.ts` now decodes these on ingest, so no new row can
-- carry an entity. This backfills the rows written before that landed.
--
-- `&amp;` is replaced LAST, which reproduces the single-pass semantics of the
-- TypeScript decoder: `&amp;lt;` becomes the text `&lt;`, not `<`. Replacing it
-- first would collapse both layers.
--
-- Deliberately scoped to these three columns. Markdown, code, diff and artifact
-- content legitimately contain entities and must stay verbatim.

UPDATE `walkthrough_semantic_steps`
SET `title` = replace(
      replace(replace(replace(replace(replace(replace(
        `title`,
        '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&apos;', ''''), '&#39;', ''''), '&nbsp;', ' '),
      '&amp;', '&')
WHERE `title` LIKE '%&%;%';
--> statement-breakpoint
UPDATE `walkthrough_issues`
SET `title` = replace(
      replace(replace(replace(replace(replace(replace(
        `title`,
        '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&apos;', ''''), '&#39;', ''''), '&nbsp;', ' '),
      '&amp;', '&')
WHERE `title` LIKE '%&%;%';
--> statement-breakpoint
UPDATE `walkthrough_issues`
SET `description` = replace(
      replace(replace(replace(replace(replace(replace(
        `description`,
        '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&apos;', ''''), '&#39;', ''''), '&nbsp;', ' '),
      '&amp;', '&')
WHERE `description` LIKE '%&%;%';
