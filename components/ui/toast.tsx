"use client"

import * as React from "react"
import { Toast as ToastPrimitive } from "@base-ui/react/toast"
import { CheckCircle2, X, XCircle } from "lucide-react"

import { cn } from "@/lib/utils"

const ToastProvider = ToastPrimitive.Provider
const ToastPortal = ToastPrimitive.Portal
const useToastManager = ToastPrimitive.useToastManager

function ToastViewport({ className, ...props }: ToastPrimitive.Viewport.Props) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        "fixed top-auto right-4 bottom-4 z-[100] mx-auto flex w-[calc(100vw-2rem)] flex-col sm:right-6 sm:bottom-6 sm:w-[22rem]",
        className
      )}
      {...props}
    />
  )
}

function ToastRoot({ className, ...props }: ToastPrimitive.Root.Props) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      className={cn(
        "[--gap:0.6rem] absolute right-0 bottom-0 left-auto w-full origin-bottom rounded-xl border-2 border-border-strong bg-card p-3 text-card-foreground shadow-brutal transition-[transform,opacity] duration-300",
        "[--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1))]",
        "[transform:translateY(var(--offset-y))_scale(calc(max(0,1-(var(--toast-index)*0.06))))]",
        "data-expanded:[transform:translateY(var(--offset-y))]",
        "data-starting-style:translate-y-[150%] data-starting-style:opacity-0",
        "data-ending-style:translate-y-[150%] data-ending-style:opacity-0",
        "data-[type=success]:bg-emerald-50 data-[type=error]:bg-destructive/10",
        className
      )}
      {...props}
    />
  )
}

function ToastContent({ className, ...props }: ToastPrimitive.Content.Props) {
  return (
    <ToastPrimitive.Content
      data-slot="toast-content"
      className={cn("flex items-start gap-2.5", className)}
      {...props}
    />
  )
}

function ToastTitle({ className, ...props }: ToastPrimitive.Title.Props) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn("text-sm font-semibold", className)}
      {...props}
    />
  )
}

function ToastDescription({ className, ...props }: ToastPrimitive.Description.Props) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function ToastClose({ className, ...props }: ToastPrimitive.Close.Props) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      aria-label="Dismiss notification"
      className={cn(
        "ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
        className
      )}
      {...props}
    >
      <X className="size-4" />
    </ToastPrimitive.Close>
  )
}

/** Renders every active toast — mount once via <Toaster /> near the root. */
function ToastList() {
  const { toasts } = useToastManager()
  return toasts.map((toast) => {
    const type = toast.type as "success" | "error" | undefined
    return (
      <ToastRoot key={toast.id} toast={toast} data-type={type}>
        <ToastContent>
          {type === "success" && (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
          )}
          {type === "error" && (
            <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          )}
          <div className="min-w-0 flex-1 space-y-0.5">
            <ToastTitle />
            <ToastDescription />
          </div>
          <ToastClose />
        </ToastContent>
      </ToastRoot>
    )
  })
}

/** Mount once near the app root (inside a ToastProvider). */
function Toaster() {
  return (
    <ToastPortal>
      <ToastViewport>
        <ToastList />
      </ToastViewport>
    </ToastPortal>
  )
}

export { ToastProvider, Toaster, useToastManager }
