"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, LogIn, Waves } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AppHeader } from "@/components/layout/app-header";
import { SeedCredentialsHelper } from "@/components/login/seed-credentials-helper";
import { createClient } from "@/lib/supabase/client";
import { formatSignInError } from "@/lib/utils";

function isSafeRedirect(path: string | null): path is string {
  // Only ever redirect back within this app — never to an external host.
  return !!path && path.startsWith("/") && !path.startsWith("//");
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirectTo");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        // Guard against unusable AuthError.message values (e.g. literal "{}")
        // and map network/config failures to actionable copy.
        setError(formatSignInError(signInError));
        return;
      }
      router.push(isSafeRedirect(redirectTo) ? redirectTo : "/");
      router.refresh();
    } catch (err) {
      setError(formatSignInError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen">
      <AppHeader title="Sign In" />
      <main className="mx-auto flex w-full max-w-sm flex-col justify-center gap-6 p-4 py-10">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Waves className="size-6" />
        </div>
        <h1 className="text-xl font-bold tracking-tight">Sign in to SSC</h1>
        <p className="text-sm text-muted-foreground">
          {redirectTo
            ? "Sign in to continue to the page you requested."
            : "Access your athlete, coach, official, or admin portal."}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account sign-in</CardTitle>
          <CardDescription>Use the email and password from your SSC registration.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            {typeof error === "string" && error.length > 0 && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="login-email">Email</Label>
              <Input
                id="login-email"
                type="email"
                autoComplete="email"
                required
                className="min-h-[48px]"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                required
                className="min-h-[48px]"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" className="min-h-[48px] w-full text-base font-semibold" disabled={submitting}>
              {submitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <LogIn className="mr-2 size-4" />}
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="text-center text-sm text-muted-foreground">
        New to SSC?{" "}
        <Link href="/register" className="font-medium text-foreground underline underline-offset-4">
          Create an account
        </Link>
      </p>

      <SeedCredentialsHelper onUseCredentials={(loginEmail, loginPassword) => {
        setEmail(loginEmail);
        setPassword(loginPassword);
      }} />
      </main>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading…</main>}>
      <LoginPageInner />
    </Suspense>
  );
}
