import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/lib/i18n";
import type { ProductPreferences, ProductSettings } from "../../../shared/models";
export function ProductPreferenceFields({
  value,
  capabilities,
  disabled,
  onChange,
  appearance = true,
}: {
  value: ProductPreferences;
  capabilities: ProductSettings;
  disabled: boolean;
  onChange: (patch: Partial<ProductPreferences>) => void;
  appearance?: boolean;
}) {
  const { t } = useT();
  return (
    <div className="space-y-4">
      <fieldset disabled={disabled} className="space-y-2 disabled:opacity-50">
        <legend className="mb-2 text-sm">{t("product.closeBehavior")}</legend>
        <div className="flex flex-wrap gap-2">
          {(["tray", "exit"] as const).map((closeBehavior) => (
            <Button
              key={closeBehavior}
              variant={value.closeBehavior === closeBehavior ? "subtle" : "outline"}
              size="sm"
              aria-pressed={value.closeBehavior === closeBehavior}
              onClick={() => onChange({ closeBehavior })}
            >
              {t(`product.close.${closeBehavior}`)}
            </Button>
          ))}
        </div>
      </fieldset>
      {!capabilities.trayAvailable && (
        <p className="text-xs text-muted-foreground">{t("product.trayUnavailable")}</p>
      )}
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm">{t("settings.startWin")}</span>
        <Switch
          aria-label={t("settings.startWin")}
          checked={value.startWithWindows}
          disabled={disabled || !capabilities.startupSupported}
          onCheckedChange={(startWithWindows) => onChange({ startWithWindows })}
        />
      </div>
      {!capabilities.startupSupported && (
        <p className="text-xs text-muted-foreground">{t("product.startupUnsupported")}</p>
      )}
      {appearance && (
        <fieldset disabled={disabled} className="space-y-2 disabled:opacity-50">
          <legend className="mb-2 text-sm">{t("product.appearance")}</legend>
          <div className="flex gap-2">
            {(["dark", "light", "system"] as const).map((theme) => (
              <Button
                key={theme}
                variant={value.theme === theme ? "subtle" : "outline"}
                size="sm"
                aria-pressed={value.theme === theme}
                onClick={() => onChange({ theme })}
              >
                {t(`product.theme.${theme}`)}
              </Button>
            ))}
          </div>
        </fieldset>
      )}
      <p className="text-xs text-muted-foreground">{t("product.backgroundHint")}</p>
    </div>
  );
}
