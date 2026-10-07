import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Cloud,
  CloudOff,
  Copy,
  FilePlus,
  FolderOpen,
  FolderPlus,
  HardDrive,
  LayoutGrid,
  Library,
  List,
  MoreHorizontal,
  Play,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EmptyState,
  IconBtn,
  PageHeader,
  Segmented,
  StatusBadge,
} from "@/components/app/primitives";
import { useT } from "@/lib/i18n";
import { library, type LibraryItem } from "@/lib/mock";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/library")({
  head: () => ({
    meta: [
      { title: "Library — MediaVault" },
      {
        name: "description",
        content: "Browse, search and organize your local video library in MediaVault.",
      },
      { property: "og:title", content: "Library — MediaVault" },
      { property: "og:description", content: "Your personal, organized video library." },
    ],
  }),
  component: LibraryPage,
});

type Cat = "all" | LibraryItem["category"];
type Store = "any" | "local" | "drive" | "both";

function LibraryPage() {
  const { t } = useT();
  const [view, setView] = useState<"grid" | "list">("grid");
  const [cat, setCat] = useState<Cat>("all");
  const [store, setStore] = useState<Store>("any");
  const [sort, setSort] = useState("newest");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<LibraryItem | null>(null);
  const [empty, setEmpty] = useState(false);

  const items = useMemo(() => {
    let xs = empty
      ? []
      : library.filter(
          (i) =>
            (cat === "all" || i.category === cat) &&
            (store === "any" ||
              (store === "local" && i.local && !i.drive) ||
              (store === "drive" && i.drive && !i.local) ||
              (store === "both" && i.local && i.drive)) &&
            i.title.toLowerCase().includes(q.toLowerCase()),
        );
    if (sort === "name") xs = [...xs].sort((a, b) => a.title.localeCompare(b.title));
    if (sort === "size")
      xs = [...xs].sort(
        (a, b) =>
          parseFloat(b.size) * (b.size.includes("GB") ? 1000 : 1) -
          parseFloat(a.size) * (a.size.includes("GB") ? 1000 : 1),
      );
    return xs;
  }, [cat, store, q, sort, empty]);

  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader
        title={t("nav.library")}
        subtitle={`${library.length} items · 21.3 GB`}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => toast(t("common.comingSoon"))}>
              <FilePlus />
              {t("library.addFile")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => toast(t("common.comingSoon"))}>
              <FolderPlus />
              {t("library.addFolder")}
            </Button>
            <Button size="sm" variant="outline">
              <RefreshCw />
              {t("library.refresh")}
            </Button>
          </>
        }
      />
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div className="flex h-9 w-72 items-center gap-2 rounded-lg border border-input bg-surface px-3 focus-within:ring-1 focus-within:ring-ring">
          <Search className="size-4 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("library.searchPh")}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <Select value={store} onValueChange={(v) => setStore(v as Store)}>
          <SelectTrigger className="h-9 w-auto min-w-40 bg-surface">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["any", "local", "drive", "both"] as Store[]).map((s) => (
              <SelectItem key={s} value={s}>
                {t(`library.storage.${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={setSort}>
          <SelectTrigger className="h-9 w-auto min-w-36 bg-surface">
            <span className="text-muted-foreground">{t("common.sort")}:</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">{t("library.sortNewest")}</SelectItem>
            <SelectItem value="name">{t("library.sortName")}</SelectItem>
            <SelectItem value="size">{t("library.sortSize")}</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto flex rounded-lg border border-border bg-chrome p-1">
          <IconBtn
            icon={LayoutGrid}
            label={t("library.grid")}
            active={view === "grid"}
            onClick={() => setView("grid")}
            className="size-7"
          />
          <IconBtn
            icon={List}
            label={t("library.list")}
            active={view === "list"}
            onClick={() => setView("list")}
            className="size-7"
          />
        </div>
      </div>
      <Segmented
        className="mt-3"
        value={cat}
        onChange={setCat}
        items={(["all", "movies", "videos", "youtube", "social", "other"] as Cat[]).map((c) => ({
          value: c,
          label: t(`library.cats.${c}`),
          count: c === "all" ? library.length : library.filter((i) => i.category === c).length,
        }))}
      />

      <div className="mt-5">
        {items.length === 0 ? (
          <div className="panel">
            <EmptyState
              icon={Library}
              title={t("library.empty")}
              hint={t("library.emptyHint")}
              action={
                <Button size="sm" variant="subtle">
                  <FolderPlus />
                  {t("library.addFolder")}
                </Button>
              }
            />
          </div>
        ) : view === "grid" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
            {items.map((i) => (
              <Card key={i.id} i={i} onOpen={() => setSel(i)} />
            ))}
          </div>
        ) : (
          <div className="panel overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  {(
                    [
                      "title",
                      "duration",
                      "resolution",
                      "size",
                      "source",
                      "date",
                      "storage",
                    ] as const
                  ).map((c) => (
                    <th key={c} className="px-4 py-2.5 font-medium">
                      {t(`library.cols.${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr
                    key={i.id}
                    onClick={() => setSel(i)}
                    className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-2"
                  >
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-3">
                        <img
                          src={i.thumb}
                          alt=""
                          loading="lazy"
                          width={1088}
                          height={608}
                          className="aspect-video w-16 rounded object-cover"
                        />
                        <span className="font-medium">{i.title}</span>
                      </div>
                    </td>
                    <td className="px-4 font-mono text-xs text-muted-foreground">{i.duration}</td>
                    <td className="px-4 font-mono text-xs text-muted-foreground">{i.resolution}</td>
                    <td className="px-4 font-mono text-xs">{i.size}</td>
                    <td className="px-4 text-xs text-muted-foreground">{i.source}</td>
                    <td className="px-4 font-mono text-xs text-muted-foreground">{i.date}</td>
                    <td className="px-4">
                      <StorageIcons i={i} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="mt-4 text-right">
        <button
          className="text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => setEmpty((e) => !e)}
        >
          {empty ? t("common.showData") : t("common.simulate")}
        </button>
      </div>
      <Details item={sel} onClose={() => setSel(null)} />
    </div>
  );
}

function StorageIcons({ i }: { i: LibraryItem }) {
  return (
    <div className="flex items-center gap-1.5">
      <HardDrive
        className={cn("size-3.5", i.local ? "text-success" : "text-muted-foreground/40")}
      />
      {i.drive ? (
        <Cloud className="size-3.5 text-primary" />
      ) : (
        <CloudOff className="size-3.5 text-muted-foreground/40" />
      )}
    </div>
  );
}

function Card({ i, onOpen }: { i: LibraryItem; onOpen: () => void }) {
  const { t } = useT();
  const stop = (fn?: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn?.();
  };
  return (
    <div
      onClick={onOpen}
      className="panel group cursor-pointer overflow-hidden transition-all hover:-translate-y-0.5 hover:border-primary/30"
    >
      <div className="relative">
        <img
          src={i.thumb}
          alt={i.title}
          loading="lazy"
          width={1088}
          height={608}
          className="aspect-video w-full object-cover"
        />
        <span className="absolute bottom-2 right-2 rounded bg-background/80 px-1.5 py-0.5 font-mono text-[10px] backdrop-blur">
          {i.duration}
        </span>
        <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-background/70 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
          <button
            onClick={stop()}
            title={t("common.play")}
            className="grid size-10 place-items-center rounded-full bg-primary text-primary-foreground"
          >
            <Play className="ml-0.5 size-4 fill-current" />
          </button>
          <IconBtn
            icon={FolderOpen}
            label={t("common.openFolder")}
            onClick={() => undefined}
            className="bg-surface-2"
          />
          <IconBtn
            icon={Upload}
            label={t("common.uploadDrive")}
            onClick={() => toast(t("common.uploadDrive"), { description: i.title })}
            className="bg-surface-2"
          />
          <IconBtn icon={MoreHorizontal} label={t("common.more")} className="bg-surface-2" />
        </div>
      </div>
      <div className="p-3">
        <p className="truncate text-sm font-semibold">{i.title}</p>
        <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="font-mono">
            {i.resolution.split("×")[1]}p · {i.size}
          </span>
          <StorageIcons i={i} />
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {i.source} · {i.date}
        </p>
      </div>
    </div>
  );
}

function Details({ item, onClose }: { item: LibraryItem | null; onClose: () => void }) {
  const { t } = useT();
  return (
    <Sheet open={!!item} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[420px] overflow-y-auto border-border bg-popover p-0 sm:max-w-[420px] [&>button]:hidden">
        {item && (
          <>
            <div className="relative">
              <img
                src={item.thumb}
                alt={item.title}
                width={1088}
                height={608}
                className="aspect-video w-full object-cover"
              />
              <div className="absolute right-2 top-2">
                <IconBtn
                  icon={X}
                  label={t("common.close")}
                  onClick={onClose}
                  className="bg-background/70 backdrop-blur"
                />
              </div>
            </div>
            <div className="p-5">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {t("details.title")}
              </p>
              <SheetTitle className="mt-1 text-lg font-bold">{item.title}</SheetTitle>
              <div className="mt-2 flex gap-2">
                <StatusBadge status="completed" />
                <StatusBadge status={item.drive ? "uploaded" : "localOnly"} />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button variant="glow" size="sm">
                  <Play />
                  {t("common.play")}
                </Button>
                <Button variant="outline" size="sm">
                  <FolderOpen />
                  {t("common.openFolder")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(item.path);
                    toast.success(t("common.copied"));
                  }}
                >
                  <Copy />
                  {t("common.copyPath")}
                </Button>
                <Button variant="outline" size="sm" disabled={item.drive}>
                  <Upload />
                  {t("common.uploadDrive")}
                </Button>
              </div>
              <dl className="mt-5 space-y-2.5 text-xs">
                {(
                  [
                    ["sourceUrl", item.url],
                    ["site", item.source],
                    ["date", item.date],
                    ["duration", item.duration],
                    ["resolution", item.resolution],
                    ["codec", item.codec],
                    ["container", item.container],
                    ["size", item.size],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{t(`details.${k}`)}</dt>
                    <dd className="truncate text-right font-mono">{v}</dd>
                  </div>
                ))}
                <div>
                  <dt className="text-muted-foreground">{t("details.path")}</dt>
                  <dd className="mt-1 break-all rounded-md bg-background p-2 font-mono text-[11px]">
                    {item.path}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t("details.drive")}</dt>
                  <dd>{item.drive ? t("status.uploaded") : t("status.localOnly")}</dd>
                </div>
              </dl>
              <div className="mt-5 rounded-lg border border-border bg-surface p-3">
                <p className="mb-2 text-xs font-semibold">{t("details.metadata")}</p>
                <dl className="grid grid-cols-2 gap-y-1.5 text-[11px]">
                  <dt className="text-muted-foreground">{t("details.bitrate")}</dt>
                  <dd className="text-right font-mono">{item.bitrate}</dd>
                  <dt className="text-muted-foreground">{t("details.fps")}</dt>
                  <dd className="text-right font-mono">{item.fps}</dd>
                  <dt className="text-muted-foreground">{t("details.audio")}</dt>
                  <dd className="text-right font-mono">{item.audio}</dd>
                </dl>
              </div>
              <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
                <Button variant="danger" size="sm">
                  <Trash2 />
                  {t("common.deleteLocal")}
                </Button>
                <Button variant="ghost" size="sm">
                  <X />
                  {t("common.removeLibrary")}
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
