"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Upload } from "lucide-react";
import { AppHeader } from "@/components/layout/app-header";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { updateMyPassword, updateMyProfile } from "@/lib/account";
import { uploadAvatar } from "@/lib/storage";
import { useCurrentUser, ROLE_LABELS } from "@/hooks/use-current-user";
import { useToast } from "@/hooks/use-toast";

export default function SettingsPage() {
  const { user, loading } = useCurrentUser();
  const toast = useToast();

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [profileImageUrl, setProfileImageUrl] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    setFullName(user.fullName);
    setProfileImageUrl(user.profileImageUrl);
  }, [user]);

  const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setProfileError(null);
    setUploadingPhoto(true);
    try {
      const res = await uploadAvatar(file);
      if (!res.url) {
        setProfileError(res.error ?? "Upload failed. Please try another image.");
        return;
      }
      setProfileImageUrl(res.url);
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleSaveProfile = async () => {
    setProfileError(null);
    setSavingProfile(true);
    try {
      const res = await updateMyProfile({ fullName, phone: phone || null, profileImageUrl });
      if (!res.success) {
        setProfileError(res.error ?? "Failed to save profile.");
        toast.error("Failed to save profile", res.error);
        return;
      }
      toast.success("Profile updated");
    } finally {
      setSavingProfile(false);
    }
  };

  const handleChangePassword = async () => {
    setPasswordError(null);
    if (!newPassword.trim()) {
      setPasswordError("Enter a new password.");
      return;
    }
    setSavingPassword(true);
    try {
      const res = await updateMyPassword(newPassword);
      if (!res.success) {
        setPasswordError(res.error ?? "Failed to change password.");
        toast.error("Failed to change password", res.error);
        return;
      }
      setNewPassword("");
      toast.success("Password changed");
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="min-h-screen">
      <AppHeader title="Account Settings" />
      <main className="mx-auto flex w-full max-w-lg flex-col gap-4 p-3 pb-24 sm:p-6">
        <header>
          <h1 className="text-2xl font-bold tracking-tight">Account Settings</h1>
          <p className="text-sm text-muted-foreground">
            Update your profile details and sign-in password.
          </p>
        </header>

        {loading || !user ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Profile</CardTitle>
                <CardDescription>
                  Signed in as {user.email} · {ROLE_LABELS[user.role]}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {profileError && (
                  <Alert variant="destructive">
                    <AlertDescription>{profileError}</AlertDescription>
                  </Alert>
                )}
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
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="fullName">Full name</Label>
                  <Input
                    id="fullName"
                    className="min-h-[48px]"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="phone">Phone number</Label>
                  <Input
                    id="phone"
                    type="tel"
                    className="min-h-[48px]"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
                <Button
                  className="min-h-[48px] w-full gap-2"
                  disabled={savingProfile || uploadingPhoto || !fullName.trim()}
                  onClick={() => void handleSaveProfile()}
                >
                  {savingProfile ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                  Save profile
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Password</CardTitle>
                <CardDescription>Change your sign-in password.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {passwordError && (
                  <Alert variant="destructive">
                    <AlertDescription>{passwordError}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="newPassword">New password</Label>
                  <Input
                    id="newPassword"
                    type="password"
                    className="min-h-[48px]"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </div>
                <Button
                  variant="outline"
                  className="min-h-[48px] w-full"
                  disabled={savingPassword}
                  onClick={() => void handleChangePassword()}
                >
                  {savingPassword && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Change password
                </Button>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
