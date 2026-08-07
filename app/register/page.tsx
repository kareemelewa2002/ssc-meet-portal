"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2, Upload, Waves } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AppHeader } from "@/components/layout/app-header";
import { cn } from "@/lib/utils";
import { ageGroupForBirthYear, ageTurningThisYear, requiresParentLink } from "@/lib/age";
import { uploadAvatar } from "@/lib/storage";
import {
  buildParentInviteLink,
  registerAccount,
  validateAthleteAge,
  validateParentLinkage,
  type SignupRole,
} from "@/lib/register";
import { previewTeamInviteToken } from "@/lib/team-invites";
import type { Gender } from "@/lib/supabase/types";

const ROLE_TABS: { value: SignupRole; label: string }[] = [
  { value: "athlete", label: "Athlete" },
  { value: "parent", label: "Parent" },
];

const STROKE_OPTIONS = ["Freestyle", "Backstroke", "Breaststroke", "Butterfly", "Individual Medley"];

function RegisterPageInner() {
  const searchParams = useSearchParams();
  const initialRole = (searchParams.get("role") as SignupRole) || "athlete";
  const inviteToken = searchParams.get("invite");

  const [role, setRole] = useState<SignupRole>(
    ROLE_TABS.some((t) => t.value === initialRole) ? initialRole : "athlete",
  );

  // Preview-only: shows "You're joining X" without consuming the token —
  // actual redemption happens server-side at signup (see lib/register.ts).
  // A stale/mistyped token resolves to null and the banner just doesn't
  // show; it never blocks the form.
  const [inviteTeamName, setInviteTeamName] = useState<string | null>(null);
  useEffect(() => {
    if (!inviteToken) return;
    let cancelled = false;
    previewTeamInviteToken(inviteToken).then((name) => {
      if (!cancelled) setInviteTeamName(name);
    });
    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  // Account fields
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptSafety, setAcceptSafety] = useState(false);
  const [acceptPrivacy, setAcceptPrivacy] = useState(false);

  // Athlete bio fields
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [gender, setGender] = useState<Gender>("male");
  const [heightCm, setHeightCm] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [profileImageUrl, setProfileImageUrl] = useState("");
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [specialtyEvents, setSpecialtyEvents] = useState<string[]>([]);
  const [parentEmail, setParentEmail] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ pendingParent: boolean } | null>(null);

  const age = useMemo(
    () => (dateOfBirth ? ageTurningThisYear(dateOfBirth) : null),
    [dateOfBirth],
  );
  const ageRejection = useMemo(
    () => (dateOfBirth ? validateAthleteAge(dateOfBirth) : { ok: true }),
    [dateOfBirth],
  );
  const ageGroupPreview = useMemo(
    () => (dateOfBirth ? ageGroupForBirthYear(dateOfBirth) : null),
    [dateOfBirth],
  );
  const needsParentEmail = dateOfBirth !== "" && requiresParentLink(dateOfBirth);

  const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoError(null);
    setUploadingPhoto(true);
    try {
      const res = await uploadAvatar(file);
      if (!res.url) {
        setPhotoError(res.error ?? "Upload failed. Please try another image.");
        return;
      }
      setProfileImageUrl(res.url);
    } finally {
      setUploadingPhoto(false);
    }
  };

  const toggleStroke = (stroke: string) => {
    setSpecialtyEvents((prev) =>
      prev.includes(stroke) ? prev.filter((s) => s !== stroke) : [...prev, stroke],
    );
  };

  const handleSubmit = async () => {
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    if (!acceptPrivacy || !acceptSafety) {
      setError("Please accept the privacy and safety terms to continue.");
      return;
    }

    if (role === "athlete") {
      const ageCheck = validateAthleteAge(dateOfBirth);
      if (!ageCheck.ok) {
        setError(ageCheck.error!);
        return;
      }
      const parentCheck = validateParentLinkage(dateOfBirth, parentEmail);
      if (!parentCheck.ok) {
        setError(parentCheck.error!);
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await registerAccount(
        { role, email, fullName, phone, password },
        role === "athlete"
          ? {
              dateOfBirth,
              gender,
              heightCm: heightCm ? Number(heightCm) : null,
              weightKg: weightKg ? Number(weightKg) : null,
              specialtyEvents,
              profileImageUrl: profileImageUrl || null,
              parentEmail: parentEmail || null,
              safetyAccepted: acceptSafety,
              teamInviteToken: inviteToken,
            }
          : undefined,
      );
      if (!res.success) {
        setError(res.error ?? "Registration failed.");
        return;
      }
      setResult({ pendingParent: role === "athlete" && needsParentEmail && !!parentEmail });
    } finally {
      setSubmitting(false);
    }
  };

  const inviteLink =
    result?.pendingParent && parentEmail && typeof window !== "undefined"
      ? buildParentInviteLink(parentEmail, window.location.origin)
      : null;

  if (result) {
    return (
      <div className="min-h-screen">
        <AppHeader title="Account Created" />
        <main className="mx-auto flex w-full max-w-lg flex-col items-center justify-center gap-4 p-4 py-16 text-center">
        <CheckCircle2 className="size-12 text-emerald-500" />
        <h1 className="text-2xl font-bold">Account created!</h1>
        {result.pendingParent ? (
          <>
            <p className="text-sm text-muted-foreground">
              Since this swimmer is under 15, a parent/guardian must authorize entries before any
              meet volume can be entered. Share this link with {parentEmail}:
            </p>
            <Card className="w-full">
              <CardContent className="break-all p-4 font-mono text-xs">{inviteLink}</CardContent>
            </Card>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">You can now sign in and register for events.</p>
        )}
        <Button nativeButton={false} render={<Link href="/" />} className="min-h-[48px] w-full">
          Go to home
        </Button>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <AppHeader title="Create Account" />
      <main className="mx-auto flex w-full max-w-lg flex-col gap-4 p-4 pb-16 sm:p-6">
      <header className="flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Waves className="size-6" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Create your SSC account</h1>
          <p className="text-sm text-muted-foreground">Join the Sprint Swimming Challenge</p>
        </div>
      </header>

      {inviteTeamName && (
        <Alert>
          <AlertDescription>
            You&apos;re signing up via an invite from <strong>{inviteTeamName}</strong> — you&apos;ll
            join the team automatically once your account is created.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-3 gap-2 rounded-lg border bg-muted/30 p-1">
        {ROLE_TABS.map((tab) => (
          <Button
            key={tab.value}
            type="button"
            variant={role === tab.value ? "default" : "ghost"}
            className="min-h-[48px] min-w-0 truncate px-1 text-xs sm:text-sm"
            onClick={() => setRole(tab.value)}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account credentials</CardTitle>
          <CardDescription>Used for sign-in across the SSC portal.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="fullName">Full name</Label>
            <Input id="fullName" className="min-h-[48px]" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" className="min-h-[48px]" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="phone">Phone number</Label>
            <Input id="phone" type="tel" className="min-h-[48px]" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" className="min-h-[48px]" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirmPassword">Confirm password</Label>
            <Input
              id="confirmPassword"
              type="password"
              className="min-h-[48px]"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              aria-invalid={confirmPassword.length > 0 && confirmPassword !== password}
            />
            {confirmPassword.length > 0 && confirmPassword !== password && (
              <p className="text-sm text-destructive">Passwords don&rsquo;t match.</p>
            )}
          </div>
        </CardContent>
      </Card>

      {role === "athlete" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Swimmer profile</CardTitle>
            <CardDescription>Biographical & physical metrics, plus specialty events.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="dob">Date of birth</Label>
              <Input
                id="dob"
                type="date"
                className="min-h-[48px]"
                value={dateOfBirth}
                onChange={(e) => setDateOfBirth(e.target.value)}
              />
              {age != null && !ageRejection.ok && (
                <p className="text-sm text-destructive">{ageRejection.error}</p>
              )}
              {age != null && ageRejection.ok && (
                <p className="text-xs text-muted-foreground">
                  Turns {age} this year — competes in the {ageGroupPreview} age group.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Gender</Label>
              <div className="flex gap-2">
                {(["male", "female"] as Gender[]).map((g) => (
                  <Button
                    key={g}
                    type="button"
                    variant={gender === g ? "default" : "outline"}
                    className="min-h-[48px] flex-1 capitalize"
                    onClick={() => setGender(g)}
                  >
                    {g}
                  </Button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="height">Height (cm)</Label>
                <Input id="height" type="number" className="min-h-[48px]" value={heightCm} onChange={(e) => setHeightCm(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="weight">Weight (kg)</Label>
                <Input id="weight" type="number" className="min-h-[48px]" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="photo">Profile photo</Label>
              <div className="flex items-center gap-3">
                <Avatar className="size-14 shrink-0">
                  {profileImageUrl ? <AvatarImage src={profileImageUrl} alt="Profile preview" /> : null}
                  <AvatarFallback>?</AvatarFallback>
                </Avatar>
                <input
                  ref={fileInputRef}
                  id="photo"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => void handlePhotoSelect(e)}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-[48px] flex-1 gap-2"
                  disabled={uploadingPhoto}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploadingPhoto ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Upload className="size-4" />
                  )}
                  {profileImageUrl ? "Change photo" : "Upload photo"}
                </Button>
              </div>
              {photoError && <p className="text-sm text-destructive">{photoError}</p>}
            </div>

            <div className="space-y-1.5">
              <Label>Specialty events</Label>
              <div className="flex flex-wrap gap-2">
                {STROKE_OPTIONS.map((stroke) => (
                  <Button
                    key={stroke}
                    type="button"
                    size="sm"
                    variant={specialtyEvents.includes(stroke) ? "default" : "outline"}
                    className="min-h-[48px] px-3 text-xs"
                    onClick={() => toggleStroke(stroke)}
                  >
                    {stroke}
                  </Button>
                ))}
              </div>
            </div>

            {needsParentEmail && (
              <div className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <Label htmlFor="parentEmail">Parent / guardian email (required — under 15)</Label>
                <Input
                  id="parentEmail"
                  type="email"
                  className="min-h-[48px]"
                  value={parentEmail}
                  onChange={(e) => setParentEmail(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Parent authorization is required before this athlete can enter any meet volume.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Privacy & safety</CardTitle>
          <CardDescription>Both are required to create an account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border-2 border-border-strong p-3">
            <input
              type="checkbox"
              id="acceptPrivacy"
              checked={acceptPrivacy}
              onChange={(e) => setAcceptPrivacy(e.target.checked)}
              className="mt-0.5 size-5 shrink-0 accent-primary"
            />
            <span className="text-sm">
              <strong className="font-bold">Privacy.</strong> I agree that my name, age group, team
              and race results are shown publicly on SSC. My phone and email stay private and are
              only shared with my own team, or with a team captain while I have a join request
              pending with them.
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border-2 border-border-strong p-3">
            <input
              type="checkbox"
              id="acceptSafety"
              checked={acceptSafety}
              onChange={(e) => setAcceptSafety(e.target.checked)}
              className="mt-0.5 size-5 shrink-0 accent-primary"
            />
            <span className="text-sm">
              <strong className="font-bold">Safety & belongings.</strong> I understand that
              swimmers are fully responsible for their own safety and for their personal
              belongings on event days, and that SSC accepts no liability for loss, damage or
              injury at the venue.
            </span>
          </label>

          {role === "athlete" && needsParentEmail && (
            <Alert>
              <AlertDescription className="text-sm">
                Because this swimmer is under 15, this acknowledgement is not theirs to give. Their
                parent or guardian must accept it from their own SSC account before the swimmer can
                register for a meet.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Button
        type="button"
        className="min-h-[48px] w-full text-base font-semibold"
        disabled={
          submitting ||
          uploadingPhoto ||
          !acceptPrivacy ||
          !acceptSafety ||
          password.length === 0 ||
          password !== confirmPassword ||
          (role === "athlete" && age != null && !ageRejection.ok)
        }
        onClick={() => void handleSubmit()}
      >
        {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
        Create account
      </Button>

      <p className={cn("text-center text-xs text-muted-foreground")}>
        Meet event registration happens separately after sign-in.
      </p>
      </main>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterPageInner />
    </Suspense>
  );
}
