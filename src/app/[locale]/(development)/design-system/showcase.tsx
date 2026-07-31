"use client";

import { useState } from "react";
import {
  ArrowRightIcon,
  BellIcon,
  CircleCheckIcon,
  MoreHorizontalIcon,
  PackageOpenIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";

import { DirectionalIcon } from "@/ui/directional-icon";
import { DestructiveConfirmation } from "@/ui/patterns/destructive-confirmation";
import { EmptyState } from "@/ui/patterns/empty-state";
import { LoadingState } from "@/ui/patterns/loading-state";
import { StatusState } from "@/ui/patterns/status-state";
import { Alert, AlertDescription, AlertTitle } from "@/ui/primitives/alert";
import { Badge } from "@/ui/primitives/badge";
import { Button } from "@/ui/primitives/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/ui/primitives/card";
import { Checkbox } from "@/ui/primitives/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/primitives/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/ui/primitives/dropdown-menu";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/ui/primitives/field";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";
import { Separator } from "@/ui/primitives/separator";
import { Skeleton } from "@/ui/primitives/skeleton";
import { Spinner } from "@/ui/primitives/spinner";
import { Textarea } from "@/ui/primitives/textarea";

const semanticTones = [
  {
    key: "primary",
    className: "bg-primary text-primary-foreground",
  },
  {
    key: "success",
    className: "bg-success text-success-foreground",
  },
  {
    key: "warning",
    className: "bg-warning text-warning-foreground",
  },
  {
    key: "info",
    className: "bg-info text-info-foreground",
  },
] as const;

function ShowcaseSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-6 border-t py-10 first:border-t-0 first:pt-0">
      <div className="max-w-2xl">
        <h2 className="text-heading-md font-bold tracking-tight">{title}</h2>
        <p className="mt-1 text-body text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function DesignSystemShowcase({ direction }: { direction: "rtl" | "ltr" }) {
  const locale = useLocale();
  const t = useTranslations("DesignSystem");
  const [pending, setPending] = useState(false);
  const formattedNumber = new Intl.NumberFormat(locale).format(1234.56);

  return (
    <div className="flex flex-col">
      <ShowcaseSection
        title={t("tokens.title")}
        description={t("tokens.description")}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {semanticTones.map((tone) => (
            <div
              key={tone.key}
              className={`rounded-lg border p-4 shadow-subtle ${tone.className}`}
            >
              {t(`tokens.${tone.key}`)}
            </div>
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border bg-card p-6 text-card-foreground shadow-raised">
            <h3 className="text-heading-lg font-bold">{t("tokens.light")}</h3>
            <p className="mt-2 text-muted-foreground">{t("tokens.surface")}</p>
          </div>
          <div className="dark rounded-xl border bg-card p-6 text-card-foreground shadow-raised">
            <h3 className="text-heading-lg font-bold">{t("tokens.dark")}</h3>
            <p className="mt-2 text-muted-foreground">{t("tokens.surface")}</p>
          </div>
        </div>
        <div className="grid gap-3 rounded-xl border bg-surface-elevated p-6 shadow-subtle">
          <p className="text-heading-xl font-bold" data-typography="heading">
            {t("typography.heading")}
          </p>
          <p className="text-body-lg font-normal" data-typography="body">
            {t("typography.body")}
          </p>
          <p className="text-label font-medium" data-typography="label">
            {t("typography.label")}
          </p>
          <p
            className="font-display text-heading-lg font-bold"
            data-typography="display-bold"
          >
            {t("typography.displayBold")}
          </p>
          <p
            className="font-display text-heading-xl font-black"
            data-typography="display-black"
          >
            {t("typography.displayBlack")}
          </p>
          <code className="font-mono text-caption" data-typography="mono">
            {t("typography.code")}
          </code>
        </div>
      </ShowcaseSection>

      <ShowcaseSection
        title={t("controls.title")}
        description={t("controls.description")}
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button>{t("controls.primary")}</Button>
          <Button variant="secondary">{t("controls.secondary")}</Button>
          <Button variant="outline">{t("controls.outline")}</Button>
          <Button variant="ghost">{t("controls.ghost")}</Button>
          <Button variant="destructive">{t("controls.destructive")}</Button>
          <Button variant="link">{t("controls.link")}</Button>
          <Button disabled>{t("controls.disabled")}</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">{t("controls.small")}</Button>
          <Button>{t("controls.default")}</Button>
          <Button size="lg">{t("controls.large")}</Button>
          <Button size="icon" aria-label={t("controls.notifications")}>
            <BellIcon />
          </Button>
          <Button disabled>
            <Spinner data-icon="inline-start" />
            {t("controls.pending")}
          </Button>
          <Button variant="outline">
            {t("controls.forward")}
            <DirectionalIcon data-icon="inline-end">
              <ArrowRightIcon />
            </DirectionalIcon>
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{t("badges.default")}</Badge>
          <Badge variant="secondary">{t("badges.secondary")}</Badge>
          <Badge variant="outline">{t("badges.outline")}</Badge>
          <Badge variant="destructive">{t("badges.destructive")}</Badge>
        </div>
      </ShowcaseSection>

      <ShowcaseSection
        title={t("forms.title")}
        description={t("forms.description")}
      >
        <FieldGroup className="max-w-2xl">
          <Field>
            <FieldLabel htmlFor="showcase-name">{t("forms.name")}</FieldLabel>
            <Input
              id="showcase-name"
              placeholder={t("forms.namePlaceholder")}
            />
            <FieldDescription>{t("forms.nameDescription")}</FieldDescription>
          </Field>
          <Field data-invalid="true">
            <FieldLabel htmlFor="showcase-email">{t("forms.email")}</FieldLabel>
            <Input
              id="showcase-email"
              dir="ltr"
              aria-invalid="true"
              aria-describedby="showcase-email-error"
              defaultValue="invalid@example"
            />
            <FieldError id="showcase-email-error">
              {t("forms.emailError")}
            </FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="showcase-message">
              {t("forms.message")}
            </FieldLabel>
            <Textarea
              id="showcase-message"
              placeholder={t("forms.messagePlaceholder")}
            />
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="showcase-checkbox" />
            <FieldLabel htmlFor="showcase-checkbox">
              {t("forms.checkbox")}
            </FieldLabel>
          </Field>
          <Field>
            <FieldLabel htmlFor="showcase-select">
              {t("forms.select")}
            </FieldLabel>
            <Select dir={direction}>
              <SelectTrigger id="showcase-select" className="w-full">
                <SelectValue placeholder={t("forms.selectPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="first">
                    {t("forms.firstOption")}
                  </SelectItem>
                  <SelectItem value="second">
                    {t("forms.secondOption")}
                  </SelectItem>
                  <SelectItem value="disabled" disabled>
                    {t("forms.disabledOption")}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
      </ShowcaseSection>

      <ShowcaseSection
        title={t("feedback.title")}
        description={t("feedback.description")}
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <Alert>
            <BellIcon />
            <AlertTitle>{t("feedback.defaultTitle")}</AlertTitle>
            <AlertDescription>
              {t("feedback.defaultDescription")}
            </AlertDescription>
          </Alert>
          <Alert variant="success">
            <CircleCheckIcon />
            <AlertTitle>{t("feedback.successTitle")}</AlertTitle>
            <AlertDescription>
              {t("feedback.successDescription")}
            </AlertDescription>
          </Alert>
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>{t("feedback.warningTitle")}</AlertTitle>
            <AlertDescription>
              {t("feedback.warningDescription")}
            </AlertDescription>
          </Alert>
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>{t("feedback.errorTitle")}</AlertTitle>
            <AlertDescription>
              {t("feedback.errorDescription")}
            </AlertDescription>
          </Alert>
        </div>
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>{t("card.title")}</CardTitle>
            <CardDescription>{t("card.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Separator />
          </CardContent>
          <CardFooter>{t("card.footer")}</CardFooter>
        </Card>
        <div className="flex max-w-xl flex-col gap-3">
          <Skeleton className="h-5 w-2/5" />
          <Skeleton className="h-20 w-full" />
          <LoadingState label={t("patterns.loading")} />
        </div>
      </ShowcaseSection>

      <ShowcaseSection
        title={t("overlays.title")}
        description={t("overlays.description")}
      >
        <div className="flex flex-wrap gap-3">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">{t("overlays.openDialog")}</Button>
            </DialogTrigger>
            <DialogContent closeLabel={t("overlays.close")}>
              <DialogHeader>
                <DialogTitle>{t("overlays.dialogTitle")}</DialogTitle>
                <DialogDescription>
                  {t("overlays.dialogDescription")}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button>{t("overlays.dialogAction")}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <DropdownMenu dir={direction}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                {t("overlays.openMenu")}
                <MoreHorizontalIcon data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("overlays.menuLabel")}</DropdownMenuLabel>
                <DropdownMenuItem>{t("overlays.menuFirst")}</DropdownMenuItem>
                <DropdownMenuItem>{t("overlays.menuSecond")}</DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    {t("overlays.menuMore")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuGroup>
                      <DropdownMenuItem>
                        {t("overlays.menuNested")}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem variant="destructive">
                  {t("overlays.menuDestructive")}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="outline"
            onClick={() => toast.success(t("overlays.toastMessage"))}
          >
            {t("overlays.showToast")}
          </Button>

          <DestructiveConfirmation
            title={t("overlays.confirmTitle")}
            description={t("overlays.confirmDescription")}
            confirmLabel={t("overlays.confirm")}
            cancelLabel={t("overlays.cancel")}
            pending={pending}
            onConfirm={() => setPending(true)}
            trigger={
              <Button variant="destructive">{t("overlays.delete")}</Button>
            }
          />
          <div className="flex items-center gap-2">
            <Checkbox
              id="showcase-pending"
              checked={pending}
              onCheckedChange={(checked) => setPending(checked === true)}
            />
            <Label htmlFor="showcase-pending">
              {t("overlays.pendingMode")}
            </Label>
          </div>
        </div>
      </ShowcaseSection>

      <ShowcaseSection
        title={t("patterns.title")}
        description={t("patterns.description")}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <EmptyState
            className="border"
            icon={<PackageOpenIcon />}
            title={t("patterns.emptyTitle")}
            description={t("patterns.emptyDescription")}
            primaryAction={<Button>{t("patterns.primaryAction")}</Button>}
            secondaryAction={
              <Button variant="outline">{t("patterns.secondaryAction")}</Button>
            }
          />
          <LoadingState
            className="rounded-xl border p-6"
            variant="content"
            label={t("patterns.loading")}
          />
          <StatusState
            status="error"
            title={t("patterns.errorTitle")}
            description={t("patterns.errorDescription")}
          />
          <StatusState
            status="forbidden"
            title={t("patterns.forbiddenTitle")}
            description={t("patterns.forbiddenDescription")}
          />
          <StatusState
            status="not-found"
            title={t("patterns.notFoundTitle")}
            description={t("patterns.notFoundDescription")}
          />
        </div>
      </ShowcaseSection>

      <ShowcaseSection
        title={t("direction.title")}
        description={t("direction.description")}
      >
        <div className="grid gap-4 rounded-xl border bg-card p-6 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <span className="text-label font-medium">
              {t("direction.userText")}
            </span>
            <p dir="auto" className="rounded-md bg-muted p-3">
              {t("direction.userTextExample")}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-label font-medium">
              {t("direction.identifiers")}
            </span>
            <span dir="ltr">hello@example.com</span>
            <span dir="ltr">https://example.com/path</span>
            <span dir="ltr">+90 555 000 0000</span>
            <code>request_01JXYZ</code>
            <span dir="ltr">{formattedNumber}</span>
          </div>
        </div>
      </ShowcaseSection>
    </div>
  );
}

export { DesignSystemShowcase };
