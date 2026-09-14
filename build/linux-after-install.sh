#!/bin/bash

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
#
# Those apparmor_parser flags are akin to performing a dry run of loading a profile.
# https://wiki.debian.org/AppArmor/HowToUse#Dumping_profiles
#
# Unfortunately, at the moment AppArmor doesn't have a good story for backwards compatibility.
# https://askubuntu.com/questions/1517272/writing-a-backwards-compatible-apparmor-profile
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Updating the current AppArmor profile is not possible and probably not meaningful in a chroot'ed environment.
    # Use cases are for example environments where images for clients are maintained.
    # There, AppArmor might correctly be installed, but live updating makes no sense.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # Extra flags taken from dh_apparmor:
      # > By using '-W -T' we ensure that any abstraction updates are also pulled in.
      # https://wiki.debian.org/AppArmor/Contribute/FirstTimeProfileImport
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

# >>> EasyMint bwrap-userns-profile (begin)
# ⚠️ 本文件是 electron-builder 内置模板 templates/linux/after-install.tpl 的**整份接管**：
#    前段（begin 标记以上）与模板逐字一致，本段以下才是 EasyMint 的追加。
#
#    为什么要整份接管：FpmTarget 的 getResource() 语义是
#      if (value == null) return path.join(defaultTemplatesDir, defaultFile);
#      return path.resolve(packager.projectDir, value);
#    ——设了 deb.afterInstall 就是**替换**而非追加。只写自己那一段会静默丢掉：
#    /usr/bin/easymint 的 alternatives 软链、chrome-sandbox 的 SUID 判定、
#    mime/desktop 数据库刷新，以及**应用自身那份 AppArmor profile（Ubuntu 24.04 上
#    让 Electron 能创建 userns 的关键）**。
#
#    维护约定：升级 electron-builder 后必须重新同步前段。
#    守卫测试 app/main/services/provisioning/__deb-postinst.test.ts 会比对本文件前段与
#    node_modules 里的模板，不一致即失败（不会静默漂移）。
#
# ─────────────────────────────────────────────────────────────────────────────
# 本段目的：让 Ubuntu 24.04+ 的 deb 用户开箱可用。
#
# 背景：Ubuntu 24.04 起 AppArmor 默认禁止非特权进程创建 user namespace
#   （kernel.apparmor_restrict_unprivileged_userns=1），bubblewrap 因此无法工作，
#   EasyMint 的系统保护初始化会失败。Ubuntu 官方给出的做法是加载 bwrap-userns-restrict
#   这份 profile，**只给 /usr/bin/bwrap 放行 userns**，而不是把限制全局关掉
#   （sysctl kernel.apparmor_restrict_unprivileged_userns=0）——同类产品（如 OpenAI Codex）
#   的官方指引也是同一条路。Ubuntu 25.04 起该 profile 已随 apparmor 包默认提供。
#   参考：https://documentation.ubuntu.com/server/how-to/security/apparmor
#
# 本段是"锦上添花"：deb 装包时应用自身那份 profile 通常已经够用，这一段是为
#   ① 应用 profile 安装被跳过（内核 abi 不支持 / apparmor_status 不可用）时兜底
#   ② 用户从非 /opt/EasyMint/easymint 路径启动（如自建软链、解包运行）时兜底
#   AppImage / tar.gz 用户没有 postinst，拿不到这段，仍需应用内指引。
#
# 硬约束（破坏任何一条都会把"安装"这件好事变成坏事）：
#   1) 绝不失败——包已经装好了，这里只是补一步；所有分支都以 exit 0 收尾，
#      不能让 dpkg 报安装失败。
#   2) 幂等——目标文件已存在就跳过（可能是系统自带，也可能用户改过），不覆盖。
#   3) 只在该限制真的生效（值为 1）时才动手；否则什么都不做。
#   4) 只写 /etc/apparmor.d/bwrap-userns-restrict 这一个文件：不碰 sysctl、
#      不改 AppArmor 全局状态、不动其它 profile。
#   5) 不接受任何来自环境变量的路径——postinst 以 root 运行，路径若可被外部注入，
#      等于给任意本地用户开了一条"以 root 写任意路径"的通道。
# ─────────────────────────────────────────────────────────────────────────────

EM_APPARMOR_DEST='/etc/apparmor.d/bwrap-userns-restrict'
EM_APPARMOR_SRC='/usr/share/apparmor/extra-profiles/bwrap-userns-restrict'
EM_APPARMOR_SRC_ALT='/usr/share/doc/apparmor-profiles/extras/bwrap-userns-restrict'
EM_APPARMOR_ENABLED='/sys/module/apparmor/parameters/enabled'
EM_APPARMOR_SYSCTL='/proc/sys/kernel/apparmor_restrict_unprivileged_userns'
EM_APPARMOR_LOG='/var/log/easymint-apparmor.log'
EM_APPARMOR_PARSER=''

em_note() {
  printf '%s easymint: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$EM_APPARMOR_LOG" 2>/dev/null || true
  printf 'EasyMint: %s\n' "$1" >&2 || true
}

# dpkg 在失败回滚阶段调用本脚本时什么都不做
case "${1:-configure}" in
  abort-upgrade|abort-remove|abort-deconfigure) exit 0 ;;
esac

# 不适用就静默退出：AppArmor 未启用，或 userns 限制未开启（含无此开关的内核）
if [ "$(cat "$EM_APPARMOR_ENABLED" 2>/dev/null)" != "Y" ]; then exit 0; fi
if [ "$(cat "$EM_APPARMOR_SYSCTL" 2>/dev/null)" != "1" ]; then exit 0; fi

# 幂等：已有同名 profile（Ubuntu 25.04+ 自带、或上次装包已落）一律不动
if [ -e "$EM_APPARMOR_DEST" ]; then exit 0; fi

EM_APPARMOR_FROM=''
if [ -f "$EM_APPARMOR_SRC" ]; then EM_APPARMOR_FROM="$EM_APPARMOR_SRC"
elif [ -f "$EM_APPARMOR_SRC_ALT" ]; then EM_APPARMOR_FROM="$EM_APPARMOR_SRC_ALT"; fi

if [ -z "$EM_APPARMOR_FROM" ]; then
  em_note "未找到 bwrap-userns-restrict 模板（apparmor-profiles 未安装？）——已跳过，可在 EasyMint「设置 → 环境检测」看手动指引"
  exit 0
fi

if ! install -m 0644 "$EM_APPARMOR_FROM" "$EM_APPARMOR_DEST" 2>/dev/null; then
  # 半成品 profile 比没有更糟（可能在下次启动时被加载并报语法错），失败就删干净
  rm -f "$EM_APPARMOR_DEST" 2>/dev/null || true
  em_note "写入 $EM_APPARMOR_DEST 失败——已跳过，可在 EasyMint「设置 → 环境检测」看手动指引"
  exit 0
fi

for EM_CAND in /usr/sbin/apparmor_parser /sbin/apparmor_parser /usr/bin/apparmor_parser; do
  if [ -x "$EM_CAND" ]; then EM_APPARMOR_PARSER="$EM_CAND"; break; fi
done
if [ -z "$EM_APPARMOR_PARSER" ]; then
  EM_APPARMOR_PARSER="$(command -v apparmor_parser 2>/dev/null || true)"
fi

# 官方文档给的命令就是 apparmor_parser -r（未加载时 -r 会直接新建，无需重启）
if [ -z "$EM_APPARMOR_PARSER" ]; then
  em_note "profile 已写入 $EM_APPARMOR_DEST，但未找到 apparmor_parser：暂未加载，重启后由 AppArmor 服务自动加载"
elif "$EM_APPARMOR_PARSER" -r "$EM_APPARMOR_DEST" >/dev/null 2>&1; then
  em_note "已加载 bwrap-userns-restrict：bubblewrap 现在可以创建用户命名空间（无需重启）"
else
  em_note "apparmor_parser -r $EM_APPARMOR_DEST 失败：文件已就位，重启后由 AppArmor 服务自动加载"
fi

exit 0
# <<< EasyMint bwrap-userns-profile (end)
