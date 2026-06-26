"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";

export default function EditClientPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    address: "",
    city: "",
    state: "",
    zip: "",
  });
  const [smsConsent, setSmsConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: client, isLoading } = trpc.clients.getById.useQuery(
    { id: params.id },
    { enabled: !!params.id }
  );

  useEffect(() => {
    if (client) {
      setForm({
        firstName: client.firstName ?? "",
        lastName: client.lastName ?? "",
        email: client.email ?? "",
        phone: client.phone ?? "",
        address: client.address ?? "",
        city: client.city ?? "",
        state: client.state ?? "",
        zip: client.zip ?? "",
      });
      setSmsConsent(client.smsConsent ?? false);
    }
  }, [client]);

  const updateClient = trpc.clients.update.useMutation({
    onSuccess: () => {
      toast.success("Client updated");
      router.push(`/clients/${params.id}`);
    },
    onError: (err) => {
      toast.error(err.message);
      setError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!form.firstName.trim() || !form.lastName.trim()) {
      setError("First name and last name are required.");
      return;
    }

    updateClient.mutate({
      id: params.id,
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim() || undefined,
      phone: form.phone.trim() || undefined,
      address: form.address.trim() || undefined,
      city: form.city.trim() || undefined,
      state: form.state.trim() || undefined,
      zip: form.zip.trim() || undefined,
      smsConsent,
    });
  };

  const updateField = (field: keyof typeof form, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  if (isLoading) {
    return (
      <div className="text-center text-muted-foreground py-12">Loading...</div>
    );
  }

  return (
    <div className="max-w-2xl">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push(`/clients/${params.id}`)}
        className="mb-4"
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to Client
      </Button>

      <h2 className="font-heading text-xl font-semibold">Edit Client</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Update client information
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="firstName">
              First Name *
            </label>
            <Input
              id="firstName"
              value={form.firstName}
              onChange={(e) => updateField("firstName", e.target.value)}
              placeholder="First name"
              className="mt-1"
              required
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="lastName">
              Last Name *
            </label>
            <Input
              id="lastName"
              value={form.lastName}
              onChange={(e) => updateField("lastName", e.target.value)}
              placeholder="Last name"
              className="mt-1"
              required
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="email">
              Email
            </label>
            <Input
              id="email"
              type="email"
              value={form.email}
              onChange={(e) => updateField("email", e.target.value)}
              placeholder="email@example.com"
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="phone">
              Phone
            </label>
            <Input
              id="phone"
              value={form.phone}
              onChange={(e) => updateField("phone", e.target.value)}
              placeholder="(555) 123-4567"
              className="mt-1"
            />
          </div>
        </div>

        <label className="flex items-start gap-2 rounded-md border border-border p-3 text-sm">
          <Checkbox
            checked={smsConsent}
            onChange={(e) => setSmsConsent(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">
              Client agrees to receive text messages
            </span>
            <span className="block text-xs text-muted-foreground">
              Appointment and care reminders by SMS. They can reply STOP to opt out
              anytime.
            </span>
          </span>
        </label>

        <div>
          <label className="text-sm font-medium" htmlFor="address">
            Address
          </label>
          <Input
            id="address"
            value={form.address}
            onChange={(e) => updateField("address", e.target.value)}
            placeholder="Street address"
            className="mt-1"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="text-sm font-medium" htmlFor="city">
              City
            </label>
            <Input
              id="city"
              value={form.city}
              onChange={(e) => updateField("city", e.target.value)}
              placeholder="City"
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="state">
              State
            </label>
            <Input
              id="state"
              value={form.state}
              onChange={(e) => updateField("state", e.target.value)}
              placeholder="State"
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="zip">
              Zip
            </label>
            <Input
              id="zip"
              value={form.zip}
              onChange={(e) => updateField("zip", e.target.value)}
              placeholder="Zip code"
              className="mt-1"
            />
          </div>
        </div>

        <div className="flex gap-3 pt-4">
          <Button type="submit" disabled={updateClient.isPending}>
            {updateClient.isPending ? "Saving..." : "Save Changes"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push(`/clients/${params.id}`)}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
