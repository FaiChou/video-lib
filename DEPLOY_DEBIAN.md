# Debian 部署：systemd 开机自动启动

使用服务器上已有的 Node.js 20+，不需要安装 npm 依赖或执行 build。以下操作在 Debian 服务器上以 root 执行，服务也使用 root 运行，无需创建额外的系统用户或组。

默认项目位置为 `/opt/video-library`，视频存放在 `/opt/video-library/videos/用户名/`，监听地址为 `0.0.0.0:8876`（所有 IPv4 网卡）。服务使用程序默认值，无需环境配置文件。

同一局域网中的设备可直接访问 **http://nuc8.local:8876**，也可使用服务器的局域网 IPv4 地址。当前版本没有登录鉴权：能访问页面的人都能浏览、下载和上传。

## 1. 上传项目并检查 Node

如果项目已经在 `/opt/video-library`（例如通过 Git 克隆），直接进入该目录检查 Node，跳过上传和第二步的文件复制。否则，把解压后的整个 `video-library` 文件夹上传到服务器，例如在本地执行：

```sh
scp -r ./video-library root@nuc8.local:~/
ssh root@nuc8.local
```

在 Debian 上进入项目目录（已经部署时改为 `cd /opt/video-library`）：

```sh
cd ~/video-library
node --version
command -v node
```

确认 Node 主版本为 20 或更高。记录 `command -v node` 的结果，后面配置 `ExecStart` 时需要用到。

## 2. 安装文件并设置权限

如果当前项目在 `/opt/video-library` 以外，先复制到目标目录；已经在目标目录时跳过此代码块，避免原地复制：

```sh
install -d -o root -g root -m 0755 /opt/video-library
install -m 0644 server.mjs package.json README.md DEPLOY_DEBIAN.md /opt/video-library/
cp -R public deploy tests /opt/video-library/
install -d -o root -g root -m 0750 /opt/video-library/videos
cp -R videos/. /opt/video-library/videos/
```

`videos/` 中有素材时会一并复制；没有素材也可以直接启动，以后通过网页上传。

然后统一设置权限：

```sh
cd /opt/video-library
chown -R root:root public deploy tests
chmod -R u=rwX,go=rX public deploy tests
install -d -o root -g root -m 0750 videos
chown -R root:root videos
chmod -R u=rwX,g=rX,o= videos
```

视频目录由 root 读写。服务保留文件系统保护配置，项目内仅允许写入 `videos/`。

最终结构：

```text
/opt/video-library/
├── server.mjs
├── package.json
├── public/
├── deploy/
├── tests/
└── videos/
    ├── selena/
    │   └── 20260813_60.mp4
    └── granada/
        └── 20261020_clip.mp4
```

## 3. 安装 service

```sh
install -m 0644 deploy/video-library.service /etc/systemd/system/video-library.service
```

程序默认监听 `0.0.0.0:8876`，允许通过 `nuc8.local`、本机地址和服务器网卡 IP 访问，使用项目下的 `videos/` 目录，日期时区为 `Asia/Shanghai`，单文件上传上限为 2 GiB。无需额外配置。

然后确认 Node 路径：

```sh
nano /etc/systemd/system/video-library.service
```

配置默认使用：

```ini
ExecStart=/usr/bin/node /opt/video-library/server.mjs
```

如果第一步查到 `/usr/local/bin/node`，将这一行改成：

```ini
ExecStart=/usr/local/bin/node /opt/video-library/server.mjs
```

使用实际路径验证 root 可以执行 Node，例如：

```sh
/usr/bin/node --version
```

**如果 Node 通过 nvm 安装在 `/root` 或 `/home` 下：** systemd 不会加载交互式 shell 的 nvm 配置，本服务也启用了 `ProtectHome`。可以复制当前已有的 Node 可执行文件到专用的系统位置：

```sh
install -D -o root -g root -m 0755 \
  "$(readlink -f "$(command -v node)")" \
  /opt/video-library-node/bin/node
/opt/video-library-node/bin/node --version
```

确认命令成功后，将 service 的 `ExecStart` 改成：

```ini
ExecStart=/opt/video-library-node/bin/node /opt/video-library/server.mjs
```

以后升级 nvm 中的 Node 时，需要重新复制这个文件，再重启服务。

## 4. 启动并设置开机自启

```sh
systemd-analyze verify /etc/systemd/system/video-library.service
systemctl daemon-reload
systemctl enable --now video-library.service
systemctl status video-library.service --no-pager -l
systemctl is-enabled video-library.service
systemctl is-active video-library.service
```

预期 `is-enabled` 输出 `enabled`，`is-active` 输出 `active`。`enable --now` 会同时设置开机启动并立即启动服务，之后不需要保持 SSH 会话连接。[systemctl 官方说明](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html)

在服务器上检查 HTTP 接口：

```sh
curl --fail http://127.0.0.1:8876/api/library
```

能得到视频列表的 JSON 就说明 HTTP 服务正常。在同一局域网中的电脑或手机浏览器访问 **http://nuc8.local:8876**，也可将 `nuc8.local` 换成服务器的局域网 IPv4 地址。

若服务器启用了防火墙，需允许局域网访问 TCP 8876 端口。

## 5. 常用维护命令

```sh
# 查看状态
systemctl status video-library --no-pager -l

# 实时查看日志，Ctrl+C 只退出日志查看
journalctl -u video-library -f

# 查看最近 100 行日志
journalctl -u video-library -n 100 --no-pager

# 重启 / 停止 / 再次启动
systemctl restart video-library
systemctl stop video-library
systemctl start video-library

# 取消开机自启，并停止当前服务
systemctl disable --now video-library
```

服务异常退出后会等待 5 秒再尝试启动；60 秒内连续启动 5 次失败会暂停重试。修好配置后执行：

```sh
systemctl reset-failed video-library
systemctl restart video-library
```

正常执行 `systemctl stop` 会保持停止，不会被自动拉起。[systemd.service 官方说明](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#Restart=)

## 6. 更新代码或素材

更新前让正在进行的上传完成，然后停止服务：

```sh
systemctl stop video-library
```

如果通过 Git 直接在 `/opt/video-library` 更新代码，跳过下面的复制命令。如果使用新版本解压目录，复制代码时保留视频：

```sh
cd ~/video-library
install -m 0644 server.mjs package.json README.md DEPLOY_DEBIAN.md /opt/video-library/
cp -R public deploy tests /opt/video-library/
```

如果旧版素材存放在其他目录，先将素材复制到 `/opt/video-library/videos/`；确认素材完整后再处理原目录。然后设置权限并更新服务文件：

```sh
cd /opt/video-library
chown -R root:root public deploy tests
chmod -R u=rwX,go=rX public deploy tests
install -d -o root -g root -m 0750 videos
chown -R root:root videos
chmod -R u=rwX,g=rX,o= videos
install -m 0644 deploy/video-library.service /etc/systemd/system/video-library.service
```

如果此前调整过 Node 路径，按第三步重新检查并设置新服务文件的 `ExecStart`。然后加载服务文件并启动：

```sh
systemctl daemon-reload
systemctl start video-library
```

旧版本升级后也会使用程序默认值，按第四步直接访问 **http://nuc8.local:8876** 或服务器的局域网 IPv4 地址。修改 `.service` 后，需要先 `systemctl daemon-reload` 再重启。

以后手动复制素材后，应确认 root 可以读写，例如：

```sh
chown -R root:root /opt/video-library/videos
chmod -R u=rwX,g=rX,o= /opt/video-library/videos
```

在网页里点击刷新即可，无需重启。备份时保留 `/opt/video-library/videos` 和 `/etc/systemd/system/video-library.service`。

## 7. 常见问题

| 现象                          | 处理                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `203/EXEC`                    | 检查 `ExecStart` 的 Node 绝对路径，用 `/实际路径/node --version` 验证权限；nvm 路径按第三步处理。 |
| `217/USER`                    | 安装新版服务文件，确认 `User=root`、`Group=root`，再执行 `daemon-reload`、`reset-failed` 和 `restart`。                                                                           |
| `EADDRINUSE`                  | 服务器的 8876 端口被占用，停止占用该端口的进程后重新启动服务。                                                        |
| `EACCES` / 上传提示服务器错误 | 检查视频目录的所有者和读写权限，并查看 `journalctl` 日志。                                                              |
| `此 Host 不允许访问`          | 使用 `http://nuc8.local:8876` 或服务器的局域网 IPv4 地址，确认已安装新版 `server.mjs` 并重启服务。                       |
| 服务器本机能打开、电脑无法访问 | 确认设备处于同一局域网，并确认防火墙允许局域网访问 TCP 8876 端口。                                                      |
| `nuc8.local` 无法解析         | 改用服务器的局域网 IPv4 地址访问，例如 `http://192.168.1.10:8876`，将示例 IP 换成实际地址。                             |
| `status` 显示启动太频繁       | 先修复日志里的错误，再运行 `reset-failed` 和 `restart`。                                                                |

此配置和教程已在本地检查；实际开机自启是否成功，以你的 Debian 上 `is-enabled`、`is-active` 和 HTTP 检查结果为准。
