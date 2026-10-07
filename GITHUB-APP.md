# GitHub App Authentication

GitHub App mode is the recommended authentication mode when one physical runner fleet needs to serve multiple selected organizations plus repositories owned by a personal account.

The same GitHub App can be installed on multiple accounts. GitHub requires the App to be installable on **Any account** if you want to install it on more than the single account that owns the App.

## 1. Create the GitHub App

Open:

```text
GitHub
→ Settings
→ Developer settings
→ GitHub Apps
→ New GitHub App
```

Suggested name:

```text
Neko Runner Fleet
```

A homepage URL is required by GitHub. It can point at your runner dashboard or project repository.

Webhooks are not required by this runner fleet. If GitHub presents an Active webhook checkbox, it can be disabled unless you want to use the App for additional webhook features later.

For installation availability choose:

```text
Any account
```

This allows the same App to be installed on your personal account and each organization you control. Publishing to GitHub Marketplace is not required.

## 2. Required permissions

Configure these GitHub App permissions.

### Organization permissions

```text
Self-hosted runners: Read and write
```

This is required for organization-scoped runner registration, removal, discovery and custom runner label management.

### Repository permissions

```text
Administration: Read and write
Metadata: Read
```

Repository Administration write access is required for repository-scoped self-hosted runner registration/removal. Metadata read is normally included by GitHub automatically and is useful for repository discovery.

No Contents write, Issues, Pull requests, Secrets, Actions workflow write, or user impersonation permission is required for the runner-management feature itself.

## 3. Install the App

After creating the App, open:

```text
Developer settings
→ GitHub Apps
→ Neko Runner Fleet
→ Install App
```

Install the same App on every account that should be managed.

Example:

```text
Personal:
- NekoSuneVR

Organizations:
- NekoSuneProjects
- NekoSuneProjectsForks
- AnotherSelectedOrg
```

For each installation choose either:

```text
All repositories
```

or:

```text
Only select repositories
```

Organization-level runners can serve repositories allowed by the organization's runner configuration. Personal-account runners are repository-scoped, so the App must be installed with access to every personal repository that should receive a runner.

## 4. Generate a private key

In the GitHub App settings page:

```text
Private keys
→ Generate a private key
```

GitHub downloads a PEM file.

Keep this file secret. Never commit it to the repository.

The easiest way to put it in a Docker `.env` file is to base64 encode it.

Linux:

```bash
base64 -w0 your-app.private-key.pem
```

macOS/BSD:

```bash
base64 < your-app.private-key.pem | tr -d '\n'
```

Put the resulting one-line value into:

```env
GITHUB_APP_PRIVATE_KEY_BASE64=PASTE_THE_BASE64_VALUE_HERE
```

The fleet also accepts an escaped PEM through `GITHUB_APP_PRIVATE_KEY`, but base64 is recommended because multiline values are easier to break in Compose/`.env` files.

## 5. Find the App ID

The GitHub App settings page shows an **App ID**.

This is not the Client ID.

Example:

```env
GITHUB_APP_ID=123456
```

## 6. Configure the runner node

Recommended configuration:

```env
GITHUB_AUTH_MODE=app

GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_BASE64=PASTE_BASE64_PRIVATE_KEY_HERE

# No PAT is required in App mode.
ACCESS_TOKEN=

# All organization installations of this App:
GITHUB_ORGS=auto

# Or only selected organizations:
# GITHUB_ORGS=NekoSuneProjects,NekoSuneProjectsForks

GITHUB_ORG_INCLUDE=
GITHUB_ORG_EXCLUDE=

# Discover repositories from personal-account installations of this App:
GITHUB_PERSONAL_REPOS=auto

# Or select explicit repositories:
# GITHUB_PERSONAL_REPOS=NekoSuneVR/RepoOne,NekoSuneVR/RepoTwo

GITHUB_PERSONAL_REPO_INCLUDE=
GITHUB_PERSONAL_REPO_EXCLUDE=
GITHUB_PERSONAL_INCLUDE_ARCHIVED=false

RUNNER_NAME_PREFIX=uk-vps-02
LABELS=docker,buildx,multiarch,builder
```

Then start/recreate the node:

```bash
docker compose -f docker-compose.node.yml pull
docker compose -f docker-compose.node.yml up -d --force-recreate
docker compose -f docker-compose.node.yml logs -f node-agent
```

## How App mode works

The node-agent keeps the App private key only in the node-agent container.

For API operations it:

1. creates an RS256 GitHub App JWT;
2. finds the App installation for the target organization or repository;
3. requests a short-lived installation access token;
4. caches that installation token until shortly before expiry;
5. uses the target installation token to register/manage the appropriate runner;
6. synchronizes runner custom labels through that same target installation.

Installation access tokens expire after roughly one hour. The fleet refreshes its API token cache before expiry.

A running GitHub Actions runner does not need to be restarted every hour. In App mode, a stopped runner container is recreated with a fresh installation token when registration is needed again.

The App private key is never injected into the individual runner containers.

## Automatic organization discovery

With:

```env
GITHUB_AUTH_MODE=app
GITHUB_ORGS=auto
```

the fleet lists installations of the GitHub App and creates organization targets for installations whose account type is `Organization`.

If you only want specific organizations, use:

```env
GITHUB_ORGS=NekoSuneProjects,NekoSuneProjectsForks
```

or combine automatic discovery with:

```env
GITHUB_ORGS=auto
GITHUB_ORG_INCLUDE=NekoSuneProjects,NekoSuneProjectsForks
```

## Automatic personal repository discovery

With:

```env
GITHUB_PERSONAL_REPOS=auto
```

the fleet looks at user-account installations of the App and lists repositories accessible to those installations.

You can restrict the result:

```env
GITHUB_PERSONAL_REPO_INCLUDE=RepoOne,RepoTwo
```

or:

```env
GITHUB_PERSONAL_REPO_EXCLUDE=OldRepo,ArchiveRepo
```

## Token mode fallback

Existing PAT authentication remains supported:

```env
GITHUB_AUTH_MODE=token
ACCESS_TOKEN=github_pat_...
```

GitHub App mode and PAT mode use the same runner fleet, capacity routing, shared physical-node job lock and GitHub runner-label synchronization.

## Security

Treat the GitHub App private key like a root credential for every installation granted to the App.

Recommended practices:

- keep the PEM outside Git;
- use the base64 environment form only on trusted runner hosts;
- limit App installation to accounts/repositories that the runner fleet should manage;
- do not grant unrelated GitHub App permissions;
- rotate the App private key if it is ever exposed;
- remember that workflows targeting these self-hosted runners can access the mounted Docker socket and therefore have powerful host-level capabilities.
