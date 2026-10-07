import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, FolderOpen, Cloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { LogoMark } from "./primitives";
import { ProductPreferenceFields } from "./ProductPreferenceFields";
import { useDesktopAction } from "@/hooks/use-desktop-collections";
import { useDesktopDrive, useDriveAccountActions } from "@/hooks/use-desktop-drive";
import { productPreferences, type useDesktopProduct } from "@/hooks/use-desktop-product";
import { useT } from "@/lib/i18n";
import type {
  DownloadSettings,
  ErrorCode,
  ProductPreferences,
  ProductSettings,
  Result,
} from "../../../shared/models";

type Product = ReturnType<typeof useDesktopProduct>;
const steps = ["language", "folder", "quality", "format", "drive", "background"] as const;
export function FirstRunWizard({ product }: { product: Product }) {
  if (!product.api || !product.settings || product.settings.firstLaunchCompleted) return null;
  return <Wizard product={product} settings={product.settings} />;
}
function Wizard({ product, settings }: { product: Product; settings: ProductSettings }) {
  const { t, lang, setLang } = useT();
  const api = product.api!;
  const action = useDesktopAction();
  const drive = useDesktopDrive();
  const account = useDriveAccountActions(api);
  const [step, setStep] = useState(0);
  const [downloads, setDownloads] = useState<DownloadSettings | null>(null);
  const [prefs, setPrefs] = useState<ProductPreferences>(() => productPreferences(settings));
  const [loadError, setLoadError] = useState<ErrorCode | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoadError(null);
    void api.settings
      .getDownloads()
      .then((result) => {
        if (!active) return;
        if (result.ok) setDownloads(result.value);
        else setLoadError(result.error);
      })
      .catch(() => {
        if (active) setLoadError("settingsFailed");
      });
    return () => {
      active = false;
    };
  }, [api, retry]);
  const choose = async () => {
    const result = await action.run(() => api.downloads.chooseDirectory());
    if (result?.ok && result.value)
      setDownloads((current) => (current ? { ...current, directory: result.value! } : current));
  };
  const finish = async () => {
    if (!downloads) return;
    const result = await action.run(async (): Promise<Result<ProductSettings>> => {
      const language = await api.settings.setLanguage(lang);
      if (!language.ok) return language;
      const savedDownloads = await api.settings.updateDownloads(downloads);
      if (!savedDownloads.ok) return savedDownloads;
      const savedProduct = await api.settings.updateProduct(prefs);
      if (!savedProduct.ok) return savedProduct;
      return api.settings.completeFirstLaunch();
    });
    if (result?.ok) product.accept(result.value);
  };
  const error = action.error ?? loadError;
  return (
    <Dialog open>
      <DialogContent
        className="max-w-xl overflow-hidden border-border bg-popover p-0 [&>button]:hidden"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <div className="border-b border-border p-6">
          <div className="flex items-center gap-3">
            <LogoMark className="size-10" />
            <div>
              <DialogTitle>{t("onboarding.title")}</DialogTitle>
              <DialogDescription className="mt-1 text-xs">{t("onboarding.hint")}</DialogDescription>
            </div>
          </div>
          <div className="mt-5 flex gap-1.5" aria-hidden>
            {steps.map((key, index) => (
              <span
                key={key}
                className={`h-1 flex-1 rounded-full ${index <= step ? "bg-primary" : "bg-muted"}`}
              />
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {t("onboarding.progress", { step: step + 1, total: steps.length })}
          </p>
        </div>
        <div className="min-h-48 space-y-4 px-6 py-5">
          <h2 className="text-base font-bold">{t(`onboarding.steps.${steps[step]}`)}</h2>
          {step === 0 && (
            <div className="grid grid-cols-2 gap-3">
              {(["en", "vi"] as const).map((value) => (
                <Button
                  key={value}
                  variant={lang === value ? "subtle" : "outline"}
                  aria-pressed={lang === value}
                  onClick={() => setLang(value)}
                >
                  {t(`onboarding.languages.${value}`)}
                </Button>
              ))}
            </div>
          )}
          {step === 1 && (
            <>
              <p className="text-xs text-muted-foreground">{t("onboarding.folderHint")}</p>
              <div className="flex items-center gap-3">
                <p className="min-w-0 flex-1 break-all rounded-md border border-input bg-background p-3 font-mono text-xs">
                  {downloads?.directory ?? t("common.loading")}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!downloads || action.busy}
                  onClick={() => void choose()}
                >
                  <FolderOpen />
                  {t("common.browse")}
                </Button>
              </div>
            </>
          )}
          {step === 2 && (
            <div className="flex flex-wrap gap-2">
              {(["best", "1080", "720"] as const).map((quality) => (
                <Button
                  key={quality}
                  variant={downloads?.quality === quality ? "subtle" : "outline"}
                  aria-pressed={downloads?.quality === quality}
                  disabled={!downloads}
                  onClick={() =>
                    setDownloads((current) => (current ? { ...current, quality } : current))
                  }
                >
                  {t(`downloadDialog.quality.${quality}`)}
                </Button>
              ))}
            </div>
          )}
          {step === 3 && (
            <div className="flex gap-2">
              {(["mp4", "mkv", "original"] as const).map((container) => (
                <Button
                  key={container}
                  variant={downloads?.container === container ? "subtle" : "outline"}
                  aria-pressed={downloads?.container === container}
                  disabled={!downloads}
                  onClick={() =>
                    setDownloads((current) => (current ? { ...current, container } : current))
                  }
                >
                  {t(`downloadDialog.container.${container}`)}
                </Button>
              ))}
            </div>
          )}
          {step === 4 && (
            <>
              <p className="text-xs text-muted-foreground">{t("onboarding.driveHint")}</p>
              {drive.state.account.connected ? (
                <p className="text-sm text-success">
                  {drive.state.account.email ?? t("status.connected")}
                </p>
              ) : (
                <>
                  <Button
                    variant="subtle"
                    disabled={
                      !drive.state.account.configured ||
                      account.busy ||
                      drive.state.account.connecting
                    }
                    onClick={() => void account.run("connect")}
                  >
                    <Cloud />
                    {t(drive.state.account.connecting ? "drive.connecting" : "drive.connect")}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      !drive.state.account.configured
                        ? "desktop.errors.driveNotConfigured"
                        : drive.state.account.connecting
                          ? "drive.browserHint"
                          : "drive.connectHint",
                    )}
                  </p>
                </>
              )}
              {(account.error || drive.error) && (
                <p role="alert" className="text-xs text-destructive">
                  {t(`desktop.errors.${account.error ?? drive.error}`)}
                </p>
              )}
            </>
          )}
          {step === 5 && (
            <ProductPreferenceFields
              value={prefs}
              capabilities={settings}
              disabled={action.busy}
              appearance={false}
              onChange={(patch) => setPrefs((current) => ({ ...current, ...patch }))}
            />
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {t(`desktop.errors.${error}`)}
            </p>
          )}
          {loadError && (
            <Button variant="outline" size="sm" onClick={() => setRetry((current) => current + 1)}>
              {t("common.retry")}
            </Button>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-border bg-background/40 px-6 py-4">
          <Button
            variant="ghost"
            disabled={step === 0 || action.busy}
            onClick={() => setStep((current) => current - 1)}
          >
            <ArrowLeft />
            {t("onboarding.back")}
          </Button>
          {step === 5 ? (
            <Button
              variant="glow"
              disabled={!downloads || action.busy}
              onClick={() => void finish()}
            >
              <Check />
              {t(action.busy ? "desktop.saving" : "onboarding.finish")}
            </Button>
          ) : (
            <Button
              variant="glow"
              disabled={action.busy || (step > 0 && step < 4 && !downloads)}
              onClick={() => setStep((current) => current + 1)}
            >
              {t(
                step === 4 && !drive.state.account.connected
                  ? "onboarding.skip"
                  : "onboarding.next",
              )}
              <ArrowRight />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
