import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useLayoutEffect, useRef } from "react";

import { Command, CommandFooter, CommandInput, CommandPanel } from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";

type CommandPaletteContentProps = Omit<ComponentProps<typeof Command>, "children"> & {
  readonly children: ReactNode;
  readonly escapeLabel?: ReactNode;
  readonly footerActionLabel?: ReactNode;
  /** A second key hint after the Enter one, e.g. Shift Enter to include a folder. */
  readonly footerSecondaryAction?: { readonly keys: string; readonly label: string };
  readonly footerTrailing?: ReactNode;
  readonly inputAccessory?: ReactNode;
  /** Pinned under the input, above the list, e.g. the folders picked so far. */
  readonly inputSupplement?: ReactNode;
  readonly inputProps: ComponentProps<typeof CommandInput>;
  /**
   * How tall the results panel may grow: the palette's list, a taller file list, or the whole
   * dialog body (for modes that lay out their own status and empty states).
   */
  readonly panelSize?: "list" | "tall-list" | "fill";
  readonly showBackHint?: boolean;
  readonly testId?: string;
};

/**
 * Shared command palette chrome. Palette modes provide their query behavior,
 * results, and optional input accessory while retaining one input, panel, and
 * keyboard-hint gutter.
 */
export function CommandPaletteContent({
  children,
  escapeLabel = "Close",
  footerActionLabel,
  footerSecondaryAction,
  footerTrailing,
  inputAccessory,
  inputSupplement,
  inputProps,
  panelSize = "list",
  showBackHint,
  testId,
  ...commandProps
}: CommandPaletteContentProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Direct-open flows replace the initial palette view after the dialog has
  // already moved focus. Reclaim it when the replacement input mounts so
  // typing cannot continue in the composer behind the modal.
  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="contents" data-testid={testId}>
      <Command {...commandProps}>
        <div className="relative">
          <CommandInput {...inputProps} ref={inputRef} />
          {inputAccessory}
        </div>
        {inputSupplement}
        <CommandPanel
          className={
            panelSize === "fill"
              ? "flex min-h-0 flex-1 flex-col"
              : panelSize === "tall-list"
                ? "max-h-[min(34rem,76vh)]"
                : "max-h-[min(28rem,70vh)]"
          }
        >
          {children}
        </CommandPanel>
        <CommandFooter className="max-sm:flex-col max-sm:items-start">
          <div className="flex items-center gap-3">
            {/* A second action hint takes the arrows' place, so the footer keeps one line. */}
            {footerSecondaryAction ? null : (
              <KbdGroup>
                <Kbd>
                  <ArrowUpIcon />
                </Kbd>
                <Kbd>
                  <ArrowDownIcon />
                </Kbd>
                <span>Navigate</span>
              </KbdGroup>
            )}
            {footerActionLabel !== undefined ? (
              <KbdGroup>
                <Kbd>Enter</Kbd>
                <span>{footerActionLabel}</span>
              </KbdGroup>
            ) : null}
            {footerSecondaryAction ? (
              <KbdGroup>
                <Kbd>{footerSecondaryAction.keys}</Kbd>
                <span>{footerSecondaryAction.label}</span>
              </KbdGroup>
            ) : null}
            {showBackHint ? (
              <KbdGroup>
                <Kbd>Backspace</Kbd>
                <span>Back</span>
              </KbdGroup>
            ) : null}
            <KbdGroup>
              <Kbd>Esc</Kbd>
              <span>{escapeLabel}</span>
            </KbdGroup>
          </div>
          {footerTrailing}
        </CommandFooter>
      </Command>
    </div>
  );
}
