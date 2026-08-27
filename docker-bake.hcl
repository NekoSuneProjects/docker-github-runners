variable "IMAGE" {
  default = "ghcr.io/YOUR_ORG/github-builder-runner"
}

group "default" {
  targets = ["runner"]
}

target "runner" {
  context = "."
  dockerfile = "Dockerfile"

  platforms = [
    "linux/amd64",
    "linux/arm64"
  ]

  tags = [
    "${IMAGE}:latest"
  ]
}
