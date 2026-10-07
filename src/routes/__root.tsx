import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { I18nProvider, useT } from "@/lib/i18n";
import { AppShell } from "@/components/app/AppShell";
import { Toaster } from "@/components/ui/sonner";

function NotFoundComponent() {
  return (
    <I18nProvider>
      <NotFoundView />
    </I18nProvider>
  );
}

function NotFoundView() {
  const { t } = useT();
  return (
    <div className="flex h-full items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-5xl font-bold text-foreground">404</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("desktop.pages.notFound")}</p>
        <Link
          to="/"
          className="mt-6 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          {t("desktop.pages.home")}
        </Link>
      </div>
    </div>
  );
}

function ErrorComponent(props: ErrorComponentProps) {
  return (
    <I18nProvider>
      <ErrorView {...props} />
    </I18nProvider>
  );
}

function ErrorView({ error, reset }: ErrorComponentProps) {
  const { t } = useT();
  const router = useRouter();
  useEffect(() => {
    if (!import.meta.env["VITE_DESKTOP"]) {
      console.error(error);
      reportLovableError(error, { boundary: "tanstack_root_error_component" });
    }
  }, [error]);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("desktop.pages.failed")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("desktop.pages.retryHint")}</p>
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="mt-6 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          {t("common.retry")}
        </button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "MediaVault" },
      { name: "description", content: "MediaVault — personal desktop media manager." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Manrope:wght@400;500;600;700;800&display=swap",
      },
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  if (import.meta.env["VITE_DESKTOP"]) return <>{children}</>;
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <AppShell>
          <Outlet />
        </AppShell>
        <Toaster theme="dark" position="bottom-right" />
      </I18nProvider>
    </QueryClientProvider>
  );
}
