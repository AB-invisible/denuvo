# ── UbiTokenService — Linux container for Railway ──────────────────────────
#
# Runs the Ubisoft Denuvo token minter (DenuvoTicket.dll) on Linux behind an
# HTTP endpoint the Discord bot calls. The tool is a managed .NET 8 app; the
# token-mint path (Ubisoft login → Uplay demux → ownership/denuvo services)
# uses protobuf + built-in ZLibStream (deflate) only. The tool's Windows-only
# native deps (lzham.dll / libzstd.dll via kernel32 SetDllDirectory) are used
# solely by manifest/download code paths that minting never touches, and their
# static initializers no-op on non-Windows — so no Windows natives are needed.
#
# libzstd1 is installed anyway (cheap) so the managed ZstdNet P/Invoke resolves
# if any future path calls it.

# 1. Build the wrapper
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY src/UbiTokenService.csproj ./
RUN dotnet restore UbiTokenService.csproj
COPY src/ ./
RUN dotnet publish UbiTokenService.csproj -c Release -o /out /p:UseAppHost=false

# 2. Runtime image
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app

# libzstd for the managed ZstdNet import; provide the unversioned soname too.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libzstd1 \
 && rm -rf /var/lib/apt/lists/* \
 && ARCH="$(dpkg --print-architecture)" \
 && case "$ARCH" in \
      amd64) LIBDIR=/usr/lib/x86_64-linux-gnu ;; \
      arm64) LIBDIR=/usr/lib/aarch64-linux-gnu ;; \
      *)     LIBDIR="$(dirname "$(find /usr/lib -name 'libzstd.so.1' | head -n1)")" ;; \
    esac \
 && if [ -n "$LIBDIR" ] && [ -f "$LIBDIR/libzstd.so.1" ] && [ ! -e "$LIBDIR/libzstd.so" ]; then \
      ln -s "$LIBDIR/libzstd.so.1" "$LIBDIR/libzstd.so"; \
    fi

# The minter tool + its managed dependencies.
COPY tool/ /app/tool/

# The wrapper.
COPY --from=build /out/ /app/

ENV UBISOFT_TOOL_DIR=/app/tool \
    LOGIN_STORE_PATH=/data/LoginStore.dat \
    ASPNETCORE_URLS=http://0.0.0.0:8080 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1

EXPOSE 8080
ENTRYPOINT ["dotnet", "/app/UbiTokenService.dll"]
