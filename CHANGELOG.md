# Changelog

All notable changes to Propel. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- The product is renamed to **Propel** (it was first "Lintel", then "Keyline"). Names in the
  app, emails, PDFs, docs, the package, Cloudflare resources (`propel`, `propel-cache`,
  `propel-media`, `propel-jobs`, `propel-jobs-dlq`, and `-staging`), demo logins
  (`@demo.propel`) and the local data folder (`~/.propel`) follow. Sign-in, consent and
  currency cookies, browser storage keys and `KEYLINE_*` environment variables keep working
  under their old names and move to the new ones; database objects and old migrations keep
  their names.

### Added

- Project scaffold: Next.js 16 (App Router, Cache Components), TypeScript strict, Tailwind CSS v4, ESLint + Prettier.
- Database: Drizzle schema and migrations; local PostgreSQL 18 (PGlite) with PostGIS, pgvector, pg_trgm, unaccent.
- Settings for all 12 groups with a cached loader; encrypted integration secrets; append-only audit log.
- Design tokens from Branding settings, shadcn/ui, i18n dictionaries, site/account/admin shells.
- Authentication: customer sign-up with email verification, password reset, admin 2FA, login lockout, setup command.
- Background jobs with retries and dead-lettering; rate limits; health check.
- Admin UI kit (fields, side panels, confirm dialogs, sortable lists, URL-driven data table).
- Setup: locations tree with map pin and boundary drawing, property types, facilities, badges, POI types, places (with Google import), developers (merge), agent profiles; slug changes create 301 redirects.
- Media library on R2 (local disk in development): signed uploads, processing job (lossless metadata strip, HEIC conversion in the browser, dimensions, placeholder colour), folders, alt text, crops, usage, replace, safe delete, resized variants; media picker.
- Settings screens for all 12 groups, including the branding editor with live preview and contrast check, pipeline stages, and integrations with encrypted keys and connection tests.
- Admin users (invite, deactivate, reset two-step verification, API tokens), audit log viewer, System page (jobs, scheduled tasks, integration status, retry).
- Listings: property list (filters, saved views, bulk actions, quick actions), property editor (all sections, autosave, publish rules, completeness score), payment plan builder and templates, rich text descriptions, price history and automatic badges, nearby places with travel times (Google Routes or straight-line), CSV import (mapping, validation preview, photo downloads) and export.
- Projects: list, editor with unit types and payment plan, nearby places, and draft listings from unit types.
- Public site: search pages (/buy, /rent, /off-plan and area landings) with filters in the URL, list and map (price pins, clusters, draw an area), autocomplete and phone layouts; property pages with gallery, payment plan, nearby places, mortgage estimate, similar homes and forms; project, developer and agent pages; currency switcher, cookie banner, helpful 404; home page from sections; Haven & Dune demo seed.
- CRM core: visitor attribution (first and last touch, journey with consent), lead pipeline for every source (dedupe, assignment, timeline, notifications, auto-reply, score with reasons, response timer), editable message templates; listing forms create leads.
- Website: page builder with every section type, templates, revisions, scheduling and preview links; blog, area guides, testimonials and FAQs; menus, footer and announcement bar; sitemap, robots, structured data, title patterns, redirects manager, 404 monitor and SEO report.
- CRM: leads list and board, lead page, shortlists, contacts and merges, manual entry and CSV import; inbox with WhatsApp, email, portals, social lead forms and website chat; campaign links with QR codes; viewings booked online with reminders, invites and a private link to move or cancel.
- Viewings admin calendar with Google Calendar sync, days off, and tours on project pages; message templates editor; page forms as leads; newsletter with double opt-in; campaign report.
- Saved-search and saved-home alerts: instant, daily and weekly, price drops and status changes, with one-click unsubscribe.
- Redirects now answer with a real 301 from the middleware, and unknown addresses with a real 404.
- Customer area: save and compare homes, save searches, a sign-in prompt that finishes a guest's save, and `/account` (saved homes and shareable lists, searches, tours, inquiries, chats, compare, profile, notifications, data download and account deletion); 3 demo customers.
- Tools: mortgage calculator and rental return simulator pages (shareable, prefilled from a listing), a mortgage pre-approval form, a branded 4-page PDF brochure for listings and projects (optionally behind an email), and a side-by-side compare page.
- Owners: `/valuation` with an estimate from comparable own listings, `/list-your-property` with photos, owner requests on the lead page with a one-click draft listing; monthly price trends on area and property pages.
- Reports: Admin -> Reports with charts and CSV/PDF export, dashboard KPIs for a period, suggestion cards worked out from the data, and a weekly report email in the agency time zone.
- AI layer: one service for Anthropic and a test provider with prompts, budgets and a usage log; embeddings and hybrid search; lead scoring with rules as the fallback; the website chat and the WhatsApp agent answering from the agency's own listings, with listing cards and "Talk to a person"; a summary, requirements and score at the end of each chat.
- Admin assistant in the top bar: reads anything, and changes things only after you confirm a preview card; the same tools through an MCP server at `/api/mcp` with per-admin tokens.
- Writing helpers: listing descriptions, titles, SEO titles and descriptions (listings, posts, area guides, projects and pages), alt text, and blog and listing drafts from pasted notes.
- Weekly chat topics: the week's visitor questions grouped into topics (contact details removed first), shown to the assistant and as a "Blog idea" card on the dashboard.
- Share cards (Open Graph images) for listings, projects, area guides and posts; a commute time filter to the agency's chosen places.
- Security headers and a CSP (with a report-only switch), structured logs; System page: overdue and stuck jobs, late scheduled tasks and the release tag.
- A US-style demo preset (Maple & Main Realty) next to Haven & Dune, with seed data that follows the market settings.
- README screenshots, refreshed with `SCREENSHOTS=1` and Playwright.
- AI providers: xAI (Grok) and Google (Gemini) next to Anthropic, and a backup provider that answers when the main one fails.
- Daily summary email to admins, an email and an admin banner when an integration stops working, and a monthly reminder to check exchange rates.
- Nightly data retention: old guest chats, people whose leads were lost long ago, and visitor events after 180 days.
- Data download as a PDF too; emails when an account is deleted and when its data is downloaded.
- Page builder: a Tools section and an AI assistant teaser whose questions open the chat; "Hide the chat button on this page".
- Newsletter signup under blog posts; payment schedule PDF on listing and project pages.
- Listing descriptions: "Improve" and "Shorten" next to "Write with AI".
- Inbox: flag a bad assistant answer; the AI report shows answers, the share backed by a lookup and the flagged ones.
- Google Meet links for video viewings, from the agent's calendar event.
- Every server error is logged with the release tag, route and request id.

### Performance

- The map stylesheet loads with the map, page builder forms check input without Zod in the browser, and dialogs, the phone menu and the header menus load their code the first time they open.
- Public pages no longer send their page data twice: a listing page's HTML is about a third smaller (47.7 KB to 30.9 KB compressed). Admin keeps one shared prefetch per screen.

### Fixed

- No CSP violation report from the form checks on sign-in and other pages.
- The home page search card no longer squeezes the area field in narrow columns.
- A listing's address line names each place once ("Dubai Marina, Dubai", not "Dubai Marina, Dubai Marina, ...").
- Lighthouse accessibility 100 and SEO 100 on the home, search and listing pages on a phone.

- Blog and page rich text saved from the editor no longer fails validation ("Invalid input").
- The 404 monitor counts visits at request time instead of breaking prerendering.
- Website chat and the admin inbox no longer crash in browsers where scrolling returns a promise.
- Tour booking fits its dialog when there are many days to choose from.
- A shortlist's opens are counted once per visit in a browser (not twice, and not by link previews).

### Changed

- Documentation moved to `docs/` (specification in `docs/spec/`, build progress in `docs/PROGRESS.md`); new README, contributing guide, security policy, pull request template and licence.
