# Orca's CLI can't read STEP, so build a small OpenCASCADE converter. The
# runtime packages it needs go along to the final image (they pull in the rest).
FROM ubuntu:24.04 AS step2stl
ARG OCCT_RUNTIME="libocct-data-exchange-7.6t64 libocct-modeling-algorithms-7.6t64"
# Runtime libraries only, plus the headers unpacked from the -dev packages:
# installing those properly drags in GL/X11/FreeImage dev packages we don't use.
ARG OCCT_DEV="libocct-data-exchange-dev libocct-modeling-algorithms-dev libocct-modeling-data-dev libocct-foundation-dev libocct-ocaf-dev libocct-visualization-dev"
RUN apt-get -o Acquire::Retries=5 update \
    && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      g++ $OCCT_RUNTIME \
    && mkdir /tmp/debs && cd /tmp/debs && apt-get -o Acquire::Retries=5 download $OCCT_DEV \
    && for d in *.deb; do dpkg -x "$d" /occt; done \
    && test -f /occt/usr/include/opencascade/STEPControl_Reader.hxx \
    && rm -rf /tmp/debs /var/lib/apt/lists/* \
    && mkdir /out && echo "$OCCT_RUNTIME" > /out/packages
COPY step2stl.cpp /src/
# Linked by soname (the unversioned .so links come with the -dev packages),
# against every OpenCASCADE library; --as-needed drops the unused ones.
RUN g++ -O2 -o /out/step2stl /src/step2stl.cpp -I/occt/usr/include/opencascade -Wl,--as-needed \
      $(for f in /usr/lib/x86_64-linux-gnu/libTK*.so.7.6; do printf ' -l:%s' "${f##*/}"; done)
RUN /out/step2stl --make-test /out/test.step
RUN /out/step2stl /out/test.step /tmp/test.stl && test -s /tmp/test.stl

FROM ubuntu:24.04

ARG ORCA_VERSION=2.4.2
ARG ORCA_URL=https://github.com/SoftFever/OrcaSlicer/releases/download/v${ORCA_VERSION}/OrcaSlicer_Linux_AppImage_Ubuntu2404_V${ORCA_VERSION}.AppImage
ENV DEBIAN_FRONTEND=noninteractive \
    ORCA_VERSION=${ORCA_VERSION} \
    ORCA_BIN=/opt/orca/AppRun \
    PROFILES_DIR=/opt/orca/resources/profiles \
    DATA_DIR=/data \
    LANG=C.UTF-8

# OrcaSlicer links GTK/WebKit/GL/X11 even when only the CLI is used.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl nodejs apt-file \
      libgtk-3-0t64 libwebkit2gtk-4.1-0 libsoup-3.0-0 libsecret-1-0 \
      libgl1 libegl1 libopengl0 libglu1-mesa libosmesa6 libgles2 libgbm1 \
      libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 \
      libsm6 libice6 libx11-6 libx11-xcb1 libxext6 libxrender1 libxi6 libxrandr2 \
      libxcursor1 libxinerama1 libxfixes3 libxxf86vm1 libxtst6 libxkbcommon-x11-0 \
      libdbus-1-3 libxkbcommon0 libfontconfig1 locales \
    && rm -rf /var/lib/apt/lists/*

# Unpack the AppImage so no FUSE is needed at runtime.
RUN curl -fsSL -o /tmp/orca.AppImage "$ORCA_URL" \
    && chmod +x /tmp/orca.AppImage \
    && cd /tmp && ./orca.AppImage --appimage-extract >/dev/null \
    && mv /tmp/squashfs-root /opt/orca \
    && rm /tmp/orca.AppImage \
    && echo "$ORCA_VERSION" > /opt/orca/VERSION \
    && test -d /opt/orca/resources/profiles

# Install whatever shared libraries the binary still can't find, looked up by
# file name with apt-file. Best effort; the self-test below is the real check.
COPY install-missing-libs.sh /tmp/
RUN sh /tmp/install-missing-libs.sh /opt/orca && rm /tmp/install-missing-libs.sh

# STEP converter plus the OpenCASCADE runtime libraries it links.
COPY --from=step2stl /out/ /opt/step2stl/
RUN apt-get -o Acquire::Retries=5 update \
    && xargs apt-get -o Acquire::Retries=5 install -y --no-install-recommends < /opt/step2stl/packages \
    && rm -rf /var/lib/apt/lists/* \
    && /opt/step2stl/step2stl /opt/step2stl/test.step /tmp/test.stl && rm /tmp/test.stl

WORKDIR /app
COPY profiles.js server.js selftest.js ./

# Fail the build now if Orca can't actually slice for either printer, or a STEP part.
RUN DATA_DIR=/tmp/selftest-data ORCA_HOME=/tmp/selftest-home node selftest.js \
    && rm -rf /tmp/selftest-home

# ubuntu:24.04 ships uid 1000 "ubuntu", matching the hub's "node" user so both
# can read and write the shared /data volume.
RUN mkdir -p /data && chown ubuntu:ubuntu /data
USER ubuntu
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:8080/health >/dev/null || exit 1

CMD ["node", "server.js"]
