<script lang="ts">
  import type { WorkspaceEnvironmentDto } from "@pi-dash/contracts";
  import {
    AlertCircleIcon,
    CheckmarkCircle02Icon,
    FloppyDiskIcon,
    InformationCircleIcon,
  } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import * as Alert from "$lib/components/ui/alert";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Field from "$lib/components/ui/field";
  import { Input } from "$lib/components/ui/input";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { Spinner } from "$lib/components/ui/spinner";
  import { afterUpdate } from "svelte";
  import { api } from "../../api.js";
  import { displayPath } from "./display.js";

  export let workspaceId: string;
  export let refreshToken = 0;

  let environment: WorkspaceEnvironmentDto | undefined;
  let privateFilePath = "";
  let savedPrivateFilePath = "";
  let loading = true;
  let saving = false;
  let error = "";
  let observedWorkspaceId = "";
  let observedRefreshToken = -1;
  let loadGeneration = 0;
  let workspaceEpoch = 0;

  afterUpdate(() => {
    if (
      workspaceId === observedWorkspaceId &&
      refreshToken === observedRefreshToken
    ) {
      return;
    }
    const workspaceChanged = workspaceId !== observedWorkspaceId;
    observedWorkspaceId = workspaceId;
    observedRefreshToken = refreshToken;
    if (workspaceChanged) {
      workspaceEpoch += 1;
      environment = undefined;
      privateFilePath = "";
      savedPrivateFilePath = "";
      saving = false;
    }
    void load(workspaceId, ++loadGeneration);
  });

  async function load(id: string, requestGeneration: number): Promise<void> {
    loading = true;
    error = "";
    try {
      const response = await api.workspaceEnvironment(id);
      if (requestGeneration !== loadGeneration || id !== observedWorkspaceId)
        return;
      const draftChanged = privateFilePath !== savedPrivateFilePath;
      environment = response.environment;
      savedPrivateFilePath = response.environment.privateFilePath ?? "";
      if (!draftChanged) privateFilePath = savedPrivateFilePath;
    } catch (caught) {
      if (requestGeneration !== loadGeneration) return;
      error =
        caught instanceof Error
          ? caught.message
          : "Unable to load workspace environment configuration.";
    } finally {
      if (requestGeneration === loadGeneration) loading = false;
    }
  }

  async function save(path: string | null): Promise<void> {
    const id = observedWorkspaceId;
    const requestWorkspaceEpoch = workspaceEpoch;
    saving = true;
    error = "";
    try {
      const response = await api.updateWorkspaceEnvironment(id, {
        privateFilePath: path,
      });
      if (
        requestWorkspaceEpoch !== workspaceEpoch ||
        id !== observedWorkspaceId
      )
        return;
      environment = response.environment;
      savedPrivateFilePath = response.environment.privateFilePath ?? "";
      privateFilePath = savedPrivateFilePath;
    } catch (caught) {
      if (
        requestWorkspaceEpoch !== workspaceEpoch ||
        id !== observedWorkspaceId
      )
        return;
      error =
        caught instanceof Error
          ? caught.message
          : "Unable to update workspace environment configuration.";
    } finally {
      if (
        requestWorkspaceEpoch === workspaceEpoch &&
        id === observedWorkspaceId
      )
        saving = false;
    }
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (workspaceId !== observedWorkspaceId) return;
    const path = privateFilePath.trim();
    void save(path || null);
  }
</script>

<Card.Root>
  <Card.Header>
    <div>
      <Card.Title>Environment</Card.Title>
      <Card.Description>
        Variables are injected into Pi and shell processes without creating
        files in managed worktrees.
      </Card.Description>
    </div>
    <Card.Action>
      {#if environment}
        <Badge
          variant={environment.status === "error" ? "destructive" : "outline"}
        >
          {environment.status === "ready"
            ? `${environment.variableCount} variables`
            : environment.status === "empty"
              ? "No variables"
              : "Needs attention"}
        </Badge>
      {/if}
    </Card.Action>
  </Card.Header>
  <Card.Content class="flex flex-col gap-4">
    {#if loading && !environment}
      <div
        class="flex flex-col gap-3"
        aria-label="Loading environment configuration"
      >
        <Skeleton class="h-10 w-full" />
        <Skeleton class="h-10 w-full" />
      </div>
    {:else}
      {#if error || environment?.status === "error"}
        <Alert.Root variant="destructive" role="alert">
          <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
          <Alert.Title>Environment unavailable</Alert.Title>
          <Alert.Description>
            {error || environment?.error}
          </Alert.Description>
        </Alert.Root>
      {/if}

      {#if environment}
        <dl class="grid gap-4 sm:grid-cols-2">
          <div class="min-w-0">
            <dt class="text-sm text-muted-foreground">Automatic source</dt>
            <dd class="break-all font-mono text-sm">
              {displayPath(environment.repositoryFile.path)}
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-sm text-muted-foreground">Status</dt>
            <dd class="flex items-center gap-2 text-sm font-medium">
              <HugeiconsIcon
                icon={environment.repositoryFile.present
                  ? CheckmarkCircle02Icon
                  : InformationCircleIcon}
                strokeWidth={2}
                class="size-4 text-muted-foreground"
              />
              {environment.repositoryFile.present
                ? "Loaded automatically"
                : "Not present"}
            </dd>
          </div>
        </dl>
      {/if}

      <form onsubmit={submit}>
        <Field.FieldGroup>
          <Field.Field data-invalid={!!error}>
            <Field.FieldLabel for="private-environment-file">
              Private override file
            </Field.FieldLabel>
            <Input
              id="private-environment-file"
              value={privateFilePath}
              oninput={(event) => (privateFilePath = event.currentTarget.value)}
              placeholder="/home/user/.config/project.env"
              autocomplete="off"
              spellcheck={false}
              disabled={saving}
              aria-invalid={!!error}
            />
            <Field.FieldDescription>
              Optional absolute path. Its values override the repository .env.
              The file path is stored, but its contents never enter the Pi Dash
              database or browser.
            </Field.FieldDescription>
          </Field.Field>
          <div class="flex flex-wrap gap-2">
            <Button type="submit" disabled={saving || loading}>
              {#if saving}
                <Spinner data-icon="inline-start" />
              {:else}
                <HugeiconsIcon
                  icon={FloppyDiskIcon}
                  strokeWidth={2}
                  data-icon="inline-start"
                />
              {/if}
              {saving ? "Saving…" : "Save environment"}
            </Button>
            {#if environment?.privateFilePath}
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onclick={() => void save(null)}>Remove override</Button
              >
            {/if}
          </div>
        </Field.FieldGroup>
      </form>

      <Alert.Root>
        <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} />
        <Alert.Title>Shared with managed worktrees</Alert.Title>
        <Alert.Description>
          Every Pi agent, shell, and child process started for this workspace
          can read these variables. Only run trusted branch code with project
          secrets.
        </Alert.Description>
      </Alert.Root>
    {/if}
  </Card.Content>
</Card.Root>
