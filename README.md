# P4LensLite

P4LensLite shows Perforce history directly in VS Code.

P4LensLite 直接在 VS Code 里显示 Perforce 历史信息。

## Features

Main features:

- Line-end decorations for the current line.
- Symbol CodeLens to show collaborator information.
- Local edits are distinguished.

主要功能：

- 在当前行行尾显示 Decorations。
- 用 CodeLens 显示协作者信息。
- 本地未提交修改会区分出来。

## Requirements

Requirements:

- `p4` must be installed, and the `p4` command must work in your terminal or command prompt.
- Your workspace must be under Perforce. In the recommended setup, `p4config.txt` should be placed in one of the parent directories of the workspace you open in VS Code. P4LensLite searches upward from the current file to locate `p4config.txt`.
- If the extension `Perforce for VS Code` works correctly in the same workspace, your `p4` command and `p4config.txt` location are usually already set up correctly, so P4LensLite should also work.


前置要求：

- 需要先安装 `p4`，并且你必须能在终端或命令行里直接运行 `p4` 命令。
- 你的工作区需要位于 Perforce 环境下。按推荐方式，`p4config.txt` 应放在你用 VS Code 打开的工作区目录的某一级上级目录里。P4LensLite 会从当前文件所在目录开始逐级向上查找 `p4config.txt`。
- 如果扩展 `Perforce for VS Code` 在同一个工作区里能正常工作，通常就说明你的 `p4` 命令和 `p4config.txt` 路径已经配置正确，P4LensLite 也应该可以正常工作。

An example `pfconfig.txt`:

一个 `pfconfig.txt` 的样例如下：

```
P4PORT=<your-p4-port>
P4USER=<your-p4-username>
P4CLIENT=<your-p4-client-name>
P4IGNORE=.p4ignore.txt;.gitignore
```
