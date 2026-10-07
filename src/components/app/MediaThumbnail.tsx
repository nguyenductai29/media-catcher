import { useState } from "react";
import { Film } from "lucide-react";
import { mediaThumbnail } from "@/lib/media-display";
import { cn } from "@/lib/utils";
import type { MediaItem } from "../../../shared/models";

export function MediaThumbnail({
  item,
  className,
}: {
  item?: MediaItem | undefined;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  return item?.thumbnailPath && failed !== item.thumbnailPath ? (
    <img
      src={mediaThumbnail(item.id)}
      alt=""
      loading="lazy"
      onError={() => setFailed(item.thumbnailPath!)}
      className={cn("aspect-video w-full object-cover", className)}
    />
  ) : (
    <div className={cn("grid aspect-video w-full place-items-center bg-surface-2", className)}>
      <Film className="size-8 text-muted-foreground" />
    </div>
  );
}
