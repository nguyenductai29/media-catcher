<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- All UI strings live in src/locales/{en,vi}.json and are read via `useT().t(key)` from src/lib/i18n.tsx — keeps the app swappable to react-i18next later.
- App chrome (title bar, sidebar, status bar) is rendered once in __root via AppShell; each nav section is its own route.
- Mock data lives in src/lib/mock.ts; no backend until real desktop integrations exist.
