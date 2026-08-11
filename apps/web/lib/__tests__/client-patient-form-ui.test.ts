import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLIENT_ADDRESS_MAX_LENGTH,
  CLIENT_CITY_MAX_LENGTH,
  CLIENT_EMAIL_MAX_LENGTH,
  CLIENT_NAME_MAX_LENGTH,
  CLIENT_PHONE_MAX_LENGTH,
  CLIENT_SEARCH_MAX_LENGTH,
  CLIENT_STATE_MAX_LENGTH,
  CLIENT_ZIP_MAX_LENGTH,
  isClientSearchInputValid,
  isOptionalClientTextValid,
  isRequiredClientTextValid,
} from "../clients/policy";
import {
  PATIENT_BREED_MAX_LENGTH,
  PATIENT_COLOR_MAX_LENGTH,
  PATIENT_MICROCHIP_NUMBER_MAX_LENGTH,
  PATIENT_NAME_MAX_LENGTH,
  PATIENT_SEARCH_MAX_LENGTH,
  isOptionalPatientTextValid,
  isPatientSearchInputValid,
  isRequiredPatientTextValid,
} from "../patients/policy";

describe("client and patient form UI states", () => {
  it("keeps viewer access read-only on client and patient lists", () => {
    const clientsPage = readFileSync("app/(dashboard)/clients/page.tsx", "utf8");
    const patientsPage = readFileSync("app/(dashboard)/patients/page.tsx", "utf8");
    const clientsRouter = readFileSync("server/routers/clients.ts", "utf8");
    const patientsRouter = readFileSync("server/routers/patients.ts", "utf8");

    expect(clientsPage).toContain('import { useSession } from "next-auth/react"');
    expect(clientsPage).toContain(
      "function canManageClientsRole(role?: string | null): boolean"
    );
    expect(clientsPage).toContain("const { data: session } = useSession()");
    expect(clientsPage).toContain(
      "const canManageClients = canManageClientsRole(session?.user?.role)"
    );
    expect(clientsPage).toContain("{canManageClients && (");
    expect(clientsPage).toContain("!hasSearch && canManageClients");

    expect(patientsPage).toContain('import { useSession } from "next-auth/react"');
    expect(patientsPage).toContain(
      "function canManagePatientsRole(role?: string | null): boolean"
    );
    expect(patientsPage).toContain("const { data: session } = useSession()");
    expect(patientsPage).toContain(
      "const canManagePatients = canManagePatientsRole(session?.user?.role)"
    );
    expect(patientsPage).toContain("{canManagePatients && (");
    expect(patientsPage).toContain("!hasFilters && canManagePatients");

    for (const source of [clientsPage, patientsPage]) {
      expect(source).toContain('role === "admin"');
      expect(source).toContain('role === "veterinarian"');
      expect(source).toContain('role === "technician"');
      expect(source).toContain('role === "front_desk"');
    }

    expect(clientsRouter).toContain("const clientManagerProcedure =");
    expect(clientsRouter).toContain(
      'requireRole("admin", "veterinarian", "technician", "front_desk")'
    );
    expect(clientsRouter).toContain("create: clientManagerProcedure");
    expect(clientsRouter).toContain("update: clientManagerProcedure");
    expect(clientsRouter).toContain(
      "rotatePortalAccessToken: clientManagerProcedure"
    );

    expect(patientsRouter).toContain("const patientManagerProcedure =");
    expect(patientsRouter).toContain(
      'requireRole("admin", "veterinarian", "technician", "front_desk")'
    );
    expect(patientsRouter).toContain("create: patientManagerProcedure");
    expect(patientsRouter).toContain("update: patientManagerProcedure");
    expect(patientsRouter).toContain("addWeight: patientManagerProcedure");
    expect(patientsRouter).toContain("addAllergy: patientManagerProcedure");
  });

  it("guards direct client and patient create/edit routes to write roles", () => {
    const newClient = readFileSync(
      "app/(dashboard)/clients/new/page.tsx",
      "utf8"
    );
    const editClient = readFileSync(
      "app/(dashboard)/clients/[id]/edit/page.tsx",
      "utf8"
    );
    const newPatient = readFileSync(
      "app/(dashboard)/patients/new/page.tsx",
      "utf8"
    );
    const editPatient = readFileSync(
      "app/(dashboard)/patients/[id]/edit/page.tsx",
      "utf8"
    );

    for (const source of [newClient, editClient, newPatient, editPatient]) {
      expect(source).toContain('import { useSession } from "next-auth/react"');
      expect(source).toContain("const { data: session, status } = useSession()");
      expect(source).toContain('role === "admin"');
      expect(source).toContain('role === "veterinarian"');
      expect(source).toContain('role === "technician"');
      expect(source).toContain('role === "front_desk"');
    }

    expect(newClient).toContain("function canManageClientFormRole");
    expect(newClient).toContain("if (!canManageClientFormRole(session?.user?.role))");
    expect(newClient).toContain("Checking client access...");
    expect(newClient).toContain("Client actions are read-only");
    expect(newClient).toContain(
      "return <NewClientForm firstClinicDay={firstClinicDay} />"
    );

    expect(editClient).toContain("function canManageClientFormRole");
    expect(editClient).toContain("if (!canManageClientFormRole(session?.user?.role))");
    expect(editClient).toContain("Checking client access...");
    expect(editClient).toContain("Client actions are read-only");
    expect(editClient).toContain("return <EditClientForm />");

    expect(newPatient).toContain("function canManagePatientFormRole");
    expect(newPatient).toContain("if (!canManagePatientFormRole(session?.user?.role))");
    expect(newPatient).toContain("Checking patient access...");
    expect(newPatient).toContain("Patient actions are read-only");
    expect(newPatient).toContain("<NewPatientForm />");

    expect(editPatient).toContain("function canManagePatientFormRole");
    expect(editPatient).toContain("if (!canManagePatientFormRole(session?.user?.role))");
    expect(editPatient).toContain("Checking patient access...");
    expect(editPatient).toContain("Patient actions are read-only");
    expect(editPatient).toContain("return <EditPatientForm />");
  });

  it("keeps first-clinic-day momentum through owner, pet, and booking", () => {
    const newClient = readFileSync(
      "app/(dashboard)/clients/new/page.tsx",
      "utf8"
    );
    const newPatient = readFileSync(
      "app/(dashboard)/patients/new/page.tsx",
      "utf8"
    );

    expect(newClient).toContain('searchParams.get("setup") === "first-visit"');
    expect(newClient).toContain("First clinic day, step 1 of 3");
    expect(newClient).toContain("&setup=first-visit`");
    expect(newPatient).toContain('searchParams.get("setup") === "first-visit"');
    expect(newPatient).toContain("First clinic day, step 2 of 3");
    expect(newPatient).toContain(
      "`/schedule?setup=first-visit&patient=${encodeURIComponent(patient.name)}`"
    );
  });

  it("surfaces New Patient owner-search loading and error states", () => {
    const source = readFileSync("app/(dashboard)/patients/new/page.tsx", "utf8");

    expect(source).toContain("isLoading: isSearchingClients");
    expect(source).toContain("error: clientSearchError");
    expect(source).toContain("const clientSearchMissing =");
    expect(source).toContain("clientSearchError || clientSearchMissing");
    expect(source).toContain("Unable to search clients. Please retry.");
    expect(source).toContain("isSearchingClients ? (");
    expect(source).toContain("Searching clients...");
    expect(source).toContain("No clients found");
    expect(source.indexOf("clientSearchError || clientSearchMissing")).toBeLessThan(
      source.indexOf("No clients found")
    );
    expect(source).toContain("isClientSearchInputValid(clientSearch)");
    expect(source).toContain("maxLength={CLIENT_SEARCH_MAX_LENGTH}");
  });

  it("uses shared edit form load states before rendering empty forms", () => {
    const patientEdit = readFileSync(
      "app/(dashboard)/patients/[id]/edit/page.tsx",
      "utf8"
    );
    const clientEdit = readFileSync(
      "app/(dashboard)/clients/[id]/edit/page.tsx",
      "utf8"
    );

    expect(patientEdit).toContain(
      'import { EmptyState } from "@/components/common/empty-state"'
    );
    expect(patientEdit).toContain("function EditPatientLoadingPanel");
    expect(patientEdit).toContain("return <EditPatientLoadingPanel />");
    expect(patientEdit).toContain("error: loadError");
    expect(patientEdit).toContain("if (loadError || !patient)");
    expect(patientEdit).toContain('title="Unable to load patient"');
    expect(patientEdit).toContain('label: "Back to Patients"');
    expect(patientEdit).toContain("router.push(\"/patients\")");
    expect(patientEdit).toContain("Load the patient before saving changes.");
    expect(patientEdit).not.toContain(
      'className="text-center text-muted-foreground py-12"'
    );

    expect(clientEdit).toContain(
      'import { EmptyState } from "@/components/common/empty-state"'
    );
    expect(clientEdit).toContain("function EditClientLoadingPanel");
    expect(clientEdit).toContain("return <EditClientLoadingPanel />");
    expect(clientEdit).toContain("error: loadError");
    expect(clientEdit).toContain("if (loadError || !client)");
    expect(clientEdit).toContain('title="Unable to load client"');
    expect(clientEdit).toContain('label: "Back to Clients"');
    expect(clientEdit).toContain("router.push(\"/clients\")");
    expect(clientEdit).toContain("Load the client before saving changes.");
    expect(clientEdit).not.toContain(
      'className="text-center text-muted-foreground py-12"'
    );
  });

  it("keeps client form policy aligned with server-side client bounds", () => {
    const routerSource = readFileSync("server/routers/clients.ts", "utf8");

    expect(CLIENT_NAME_MAX_LENGTH).toBe(128);
    expect(CLIENT_EMAIL_MAX_LENGTH).toBe(255);
    expect(CLIENT_PHONE_MAX_LENGTH).toBe(32);
    expect(CLIENT_ADDRESS_MAX_LENGTH).toBe(500);
    expect(CLIENT_CITY_MAX_LENGTH).toBe(128);
    expect(CLIENT_STATE_MAX_LENGTH).toBe(64);
    expect(CLIENT_ZIP_MAX_LENGTH).toBe(16);
    expect(CLIENT_SEARCH_MAX_LENGTH).toBe(100);

    expect(isRequiredClientTextValid(" Ada ", CLIENT_NAME_MAX_LENGTH)).toBe(
      true
    );
    expect(isRequiredClientTextValid("   ", CLIENT_NAME_MAX_LENGTH)).toBe(
      false
    );
    expect(
      isRequiredClientTextValid(
        "A".repeat(CLIENT_NAME_MAX_LENGTH + 1),
        CLIENT_NAME_MAX_LENGTH
      )
    ).toBe(false);
    expect(
      isOptionalClientTextValid(" ".repeat(8), CLIENT_PHONE_MAX_LENGTH)
    ).toBe(true);
    expect(
      isOptionalClientTextValid(
        "1".repeat(CLIENT_PHONE_MAX_LENGTH + 1),
        CLIENT_PHONE_MAX_LENGTH
      )
    ).toBe(false);
    expect(isClientSearchInputValid(" Ada ")).toBe(true);
    expect(isClientSearchInputValid("   ")).toBe(false);
    expect(isClientSearchInputValid("A".repeat(101))).toBe(false);

    expect(routerSource).toContain("CLIENT_NAME_MAX_LENGTH");
    expect(routerSource).toContain("CLIENT_EMAIL_MAX_LENGTH");
    expect(routerSource).toContain("CLIENT_PHONE_MAX_LENGTH");
    expect(routerSource).toContain("CLIENT_ADDRESS_MAX_LENGTH");
    expect(routerSource).toContain("CLIENT_CITY_MAX_LENGTH");
    expect(routerSource).toContain("CLIENT_STATE_MAX_LENGTH");
    expect(routerSource).toContain("CLIENT_ZIP_MAX_LENGTH");
    expect(routerSource).toContain("CLIENT_SEARCH_MAX_LENGTH");
    expect(routerSource).toContain(
      "optionalClientString(CLIENT_PHONE_MAX_LENGTH)"
    );
    expect(routerSource).toContain(
      "optionalClientString(CLIENT_ADDRESS_MAX_LENGTH)"
    );
  });

  it("matches client create/edit form controls to server input limits", () => {
    const newClient = readFileSync(
      "app/(dashboard)/clients/new/page.tsx",
      "utf8"
    );
    const editClient = readFileSync(
      "app/(dashboard)/clients/[id]/edit/page.tsx",
      "utf8"
    );

    for (const source of [newClient, editClient]) {
      expect(source).toContain("CLIENT_NAME_MAX_LENGTH");
      expect(source).toContain("CLIENT_EMAIL_MAX_LENGTH");
      expect(source).toContain("CLIENT_PHONE_MAX_LENGTH");
      expect(source).toContain("CLIENT_ADDRESS_MAX_LENGTH");
      expect(source).toContain("CLIENT_CITY_MAX_LENGTH");
      expect(source).toContain("CLIENT_STATE_MAX_LENGTH");
      expect(source).toContain("CLIENT_ZIP_MAX_LENGTH");
      expect(source).toContain("maxLength={CLIENT_NAME_MAX_LENGTH}");
      expect(source).toContain("maxLength={CLIENT_EMAIL_MAX_LENGTH}");
      expect(source).toContain("maxLength={CLIENT_PHONE_MAX_LENGTH}");
      expect(source).toContain("maxLength={CLIENT_ADDRESS_MAX_LENGTH}");
      expect(source).toContain("maxLength={CLIENT_CITY_MAX_LENGTH}");
      expect(source).toContain("maxLength={CLIENT_STATE_MAX_LENGTH}");
      expect(source).toContain("maxLength={CLIENT_ZIP_MAX_LENGTH}");
      expect(source).toContain("const canSubmit =");
      expect(source).toContain("isRequiredClientTextValid(form.firstName");
      expect(source).toContain("isRequiredClientTextValid(form.lastName");
      expect(source).toContain("isOptionalClientTextValid(form.email");
      expect(source).toContain("isOptionalClientTextValid(form.phone");
      expect(source).toContain("isOptionalClientTextValid(form.address");
      expect(source).toContain("Check required fields and field lengths.");
    }

    expect(newClient).toContain(
      "disabled={!canSubmit || createClient.isPending}"
    );
    expect(editClient).toContain(
      "disabled={!canSubmit || updateClient.isPending}"
    );
    expect(newClient).not.toContain(
      "disabled={createClient.isPending}"
    );
    expect(editClient).not.toContain(
      "disabled={updateClient.isPending}"
    );
  });

  it("keeps patient form policy aligned with server-side patient bounds", () => {
    const routerSource = readFileSync("server/routers/patients.ts", "utf8");
    const uploadRouteSource = readFileSync("app/api/upload/route.ts", "utf8");

    expect(PATIENT_NAME_MAX_LENGTH).toBe(128);
    expect(PATIENT_BREED_MAX_LENGTH).toBe(128);
    expect(PATIENT_COLOR_MAX_LENGTH).toBe(64);
    expect(PATIENT_MICROCHIP_NUMBER_MAX_LENGTH).toBe(64);
    expect(PATIENT_SEARCH_MAX_LENGTH).toBe(128);

    expect(isRequiredPatientTextValid(" Maple ", PATIENT_NAME_MAX_LENGTH)).toBe(
      true
    );
    expect(isRequiredPatientTextValid("   ", PATIENT_NAME_MAX_LENGTH)).toBe(
      false
    );
    expect(
      isRequiredPatientTextValid(
        "M".repeat(PATIENT_NAME_MAX_LENGTH + 1),
        PATIENT_NAME_MAX_LENGTH
      )
    ).toBe(false);
    expect(
      isOptionalPatientTextValid(" ".repeat(8), PATIENT_BREED_MAX_LENGTH)
    ).toBe(true);
    expect(
      isOptionalPatientTextValid(
        "A".repeat(PATIENT_BREED_MAX_LENGTH + 1),
        PATIENT_BREED_MAX_LENGTH
      )
    ).toBe(false);
    expect(isPatientSearchInputValid(" Maple ")).toBe(true);
    expect(isPatientSearchInputValid("   ")).toBe(false);
    expect(isPatientSearchInputValid("M".repeat(129))).toBe(false);

    expect(routerSource).toContain("PATIENT_NAME_MAX_LENGTH");
    expect(routerSource).toContain("PATIENT_BREED_MAX_LENGTH");
    expect(routerSource).toContain("PATIENT_COLOR_MAX_LENGTH");
    expect(routerSource).toContain("PATIENT_MICROCHIP_NUMBER_MAX_LENGTH");
    expect(routerSource).toContain("PATIENT_SEARCH_MAX_LENGTH");
    expect(routerSource).toContain(
      "optionalPatientString(\"Breed\", PATIENT_BREED_MAX_LENGTH)"
    );
    expect(routerSource).toContain(
      "optionalPatientString(\"Color\", PATIENT_COLOR_MAX_LENGTH)"
    );
    expect(routerSource).toContain("PATIENT_MICROCHIP_NUMBER_MAX_LENGTH");

    // Photo URLs are server-owned attachment bindings now. Patient form
    // mutations cannot write arbitrary URLs; only a verified managed upload
    // can atomically bind the manifest URL to the patient.
    const mutableInputSource = routerSource.slice(
      routerSource.indexOf("const patientMutableInput"),
      routerSource.indexOf("const patientWeightInput")
    );
    const updateInputSource = routerSource.slice(
      routerSource.indexOf("update: patientManagerProcedure"),
      routerSource.indexOf("addWeight: patientManagerProcedure")
    );
    expect(mutableInputSource).not.toContain("photoUrl");
    expect(updateInputSource).not.toContain("photoUrl");
    expect(updateInputSource).toContain(".strict()");
    expect(uploadRouteSource).toContain("finalizeManagedUploadManifest(");
    expect(uploadRouteSource).toContain(
      ".set({ photoUrl: reservation.fileUrl, updatedAt: new Date() })"
    );
  });

  it("matches patient create/edit form controls to server input limits", () => {
    const newPatient = readFileSync(
      "app/(dashboard)/patients/new/page.tsx",
      "utf8"
    );
    const editPatient = readFileSync(
      "app/(dashboard)/patients/[id]/edit/page.tsx",
      "utf8"
    );

    for (const source of [newPatient, editPatient]) {
      expect(source).toContain("PATIENT_NAME_MAX_LENGTH");
      expect(source).toContain("PATIENT_BREED_MAX_LENGTH");
      expect(source).toContain("PATIENT_COLOR_MAX_LENGTH");
      expect(source).toContain("PATIENT_MICROCHIP_NUMBER_MAX_LENGTH");
      expect(source).toContain("maxLength={PATIENT_NAME_MAX_LENGTH}");
      expect(source).toContain("maxLength={PATIENT_BREED_MAX_LENGTH}");
      expect(source).toContain("maxLength={PATIENT_COLOR_MAX_LENGTH}");
      expect(source).toContain(
        "maxLength={PATIENT_MICROCHIP_NUMBER_MAX_LENGTH}"
      );
      expect(source).toContain("const canSubmit =");
      expect(source).toContain("isRequiredPatientTextValid(form.name");
      expect(source).toContain("isOptionalPatientTextValid(form.breed");
      expect(source).toContain("isOptionalPatientTextValid(form.color");
      expect(source).toContain("isOptionalPatientTextValid(");
      expect(source).toContain("form.microchipNumber");
      expect(source).toContain("Check required fields and field lengths.");
      expect(source).toContain('name="dob"');
      expect(source).toContain(
        'e.currentTarget.elements.namedItem("dob")'
      );
    }

    expect(newPatient).toContain("dob: submittedDob || undefined");
    expect(editPatient).toContain("dob: submittedDob || null");
    expect(editPatient).toContain("utils.patients.getById.setData");

    expect(newPatient).toContain(
      "disabled={!canSubmit || createPatient.isPending}"
    );
    expect(editPatient).toContain(
      "disabled={!canSubmit || updatePatient.isPending}"
    );
    expect(newPatient).not.toContain(
      "disabled={createPatient.isPending}"
    );
    expect(editPatient).not.toContain(
      "disabled={updatePatient.isPending}"
    );
  });
});
