"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCcw, Search, Shield, ShieldOff, Flag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn, getErrorMessage } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import type { UserRole, UserRow } from "@/lib/supabase/types";

export interface UserRoleManagementProps {
  initialUsers?: UserRow[];
  className?: string;
}

const DEMO_USERS: UserRow[] = [
  { id: "u1", email: "elewakareem2002@gmail.com", full_name: "Root Admin", phone: null, profile_image_url: null, role: "admin", created_at: "", updated_at: "" },
  { id: "u2", email: "coach.reyes@ssc.dev", full_name: "Coach Reyes", phone: null, profile_image_url: null, role: "coach", created_at: "", updated_at: "" },
  { id: "u3", email: "ref.alvi@ssc.dev", full_name: "Referee Alvi", phone: null, profile_image_url: null, role: "referee", created_at: "", updated_at: "" },
  { id: "u5", email: "swimmer.leo@ssc.dev", full_name: "Leo Fontaine", phone: null, profile_image_url: null, role: "athlete", created_at: "", updated_at: "" },
  { id: "u6", email: "parent.thompson@ssc.dev", full_name: "Grace Thompson", phone: null, profile_image_url: null, role: "parent", created_at: "", updated_at: "" },
];

const ELEVATABLE_ROLES: Extract<UserRole, "admin" | "referee">[] = ["admin", "referee"];

function roleBadgeVariant(role: UserRole): "default" | "secondary" | "outline" | "destructive" {
  if (role === "admin") return "destructive";
  if (role === "referee") return "default";
  if (role === "coach") return "secondary";
  return "outline";
}

export function UserRoleManagement({ initialUsers, className }: UserRoleManagementProps) {
  const [users, setUsers] = useState<UserRow[]>(initialUsers ?? DEMO_USERS);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [modalUser, setModalUser] = useState<UserRow | null>(null);

  const loadUsers = async () => {
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const { data, error: fetchError } = await supabase
        .from("users")
        .select("*")
        .order("full_name", { ascending: true });
      // Supabase/Postgrest errors are plain objects, not `Error` instances —
      // checking `err instanceof Error` below would never be true for them,
      // silently swallowing the real reason and always showing a generic
      // fallback. Read fetchError.message directly instead.
      if (fetchError) {
        setError(fetchError.message);
        return;
      }
      if (data) setUsers(data as UserRow[]);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load users — showing cached list."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!initialUsers) {
      loadUsers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) => u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
    );
  }, [users, query]);

  const applyRoleChange = async (userIds: string[], role: UserRole) => {
    setPendingUserId(userIds.length === 1 ? userIds[0] : "batch");
    setError(null);
    const previous = users;
    setUsers((prev) => prev.map((u) => (userIds.includes(u.id) ? { ...u, role } : u)));

    try {
      const supabase = createClient();
      const { error: updateError } = await supabase.from("users").update({ role }).in("id", userIds);
      if (updateError) throw updateError;
    } catch (err) {
      setUsers(previous);
      setError(getErrorMessage(err, "Failed to update role."));
    } finally {
      setPendingUserId(null);
    }
  };

  const toggleRole = (user: UserRow, role: Extract<UserRole, "admin" | "referee">) => {
    const hasRole = user.role === role;
    applyRoleChange([user.id], hasRole ? "athlete" : role);
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) =>
      prev.size === filtered.length ? new Set() : new Set(filtered.map((u) => u.id)),
    );
  };

  const batchGrant = (role: Extract<UserRole, "admin" | "referee">) => {
    applyRoleChange(Array.from(selected), role);
    setSelected(new Set());
  };

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-bold sm:text-xl">User & Role Management</h2>
          <p className="text-sm text-muted-foreground">
            Search registered users and grant or revoke admin / referee access.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-[48px] gap-2"
          onClick={loadUsers}
          disabled={loading}
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCcw className="size-4" />}
          Refresh
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or email…"
          className="h-12 pl-9 text-base"
        />
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-3">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <Button size="sm" className="min-h-[40px] gap-1" onClick={() => batchGrant("referee")}>
            <Flag className="size-4" /> Grant Referee
          </Button>
          <Button
            size="sm"
            variant="destructive"
            className="min-h-[40px] gap-1"
            onClick={() => batchGrant("admin")}
          >
            <Shield className="size-4" /> Grant Admin
          </Button>
          <Button size="sm" variant="outline" className="min-h-[40px]" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {/* Desktop: searchable data table with inline toggles + batch actions */}
      <Card className="hidden md:block">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">All Users ({filtered.length})</CardTitle>
          <CardDescription>Toggle admin or referee access inline. Changes save immediately.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={selected.size > 0 && selected.size === filtered.length}
                    onCheckedChange={toggleSelectAll}
                    aria-label="Select all users"
                  />
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Current Role</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(user.id)}
                      onCheckedChange={() => toggleSelected(user.id)}
                      aria-label={`Select ${user.full_name}`}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{user.full_name}</TableCell>
                  <TableCell className="text-muted-foreground">{user.email}</TableCell>
                  <TableCell>
                    <Badge variant={roleBadgeVariant(user.role)}>{user.role.replace("_", " ")}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {ELEVATABLE_ROLES.map((role) => {
                        const active = user.role === role;
                        const isPending = pendingUserId === user.id;
                        return (
                          <Button
                            key={role}
                            size="sm"
                            variant={active ? "destructive" : "outline"}
                            className="min-h-[40px] gap-1"
                            disabled={isPending}
                            onClick={() => toggleRole(user, role)}
                          >
                            {isPending ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : role === "admin" ? (
                              active ? <ShieldOff className="size-4" /> : <Shield className="size-4" />
                            ) : (
                              <Flag className="size-4" />
                            )}
                            {active ? `Revoke ${role}` : `Make ${role}`}
                          </Button>
                        );
                      })}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    No users match your search.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Mobile: stacked list cards with quick modal actions */}
      <div className="space-y-3 md:hidden">
        {filtered.map((user) => (
          <Card key={user.id}>
            <CardContent className="flex items-center gap-3 py-3">
              <Checkbox
                checked={selected.has(user.id)}
                onCheckedChange={() => toggleSelected(user.id)}
                aria-label={`Select ${user.full_name}`}
                className="size-5"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{user.full_name}</p>
                <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                <Badge variant={roleBadgeVariant(user.role)} className="mt-1">
                  {user.role.replace("_", " ")}
                </Badge>
              </div>
              <Dialog open={modalUser?.id === user.id} onOpenChange={(open) => setModalUser(open ? user : null)}>
                <DialogTrigger render={<Button variant="outline" className="min-h-[48px]" />}>
                  Manage
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{user.full_name}</DialogTitle>
                    <DialogDescription>{user.email}</DialogDescription>
                  </DialogHeader>
                  <div className="flex flex-col gap-3 py-2">
                    {ELEVATABLE_ROLES.map((role) => {
                      const active = user.role === role;
                      const isPending = pendingUserId === user.id;
                      return (
                        <Button
                          key={role}
                          variant={active ? "destructive" : "default"}
                          className="min-h-[48px] justify-start gap-2 text-base"
                          disabled={isPending}
                          onClick={() => toggleRole(user, role)}
                        >
                          {isPending ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : role === "admin" ? (
                            active ? <ShieldOff className="size-4" /> : <Shield className="size-4" />
                          ) : (
                            <Flag className="size-4" />
                          )}
                          {active ? `Revoke ${role} access` : `Grant ${role} access`}
                        </Button>
                      );
                    })}
                  </div>
                  <DialogFooter>
                    <Button variant="outline" className="min-h-[48px] w-full" onClick={() => setModalUser(null)}>
                      Close
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>
        ))}
        {filtered.length === 0 && (
          <p className="py-8 text-center text-muted-foreground">No users match your search.</p>
        )}
      </div>
    </div>
  );
}
