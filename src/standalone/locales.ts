/**
 * Localisation: flat dictionaries, a `t(key, vars)` helper with `{name}`
 * interpolation, and the small formatting helpers shared by every view.
 * Default is Simplified Chinese; the switch is remembered per browser.
 */
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ApiFailure } from './api.ts'

export type Locale = 'zh-CN' | 'en-US'

export const DEFAULT_LOCALE: Locale = 'zh-CN'

export type Translate = (key: string, vars?: Record<string, string | number>) => string

export interface I18nValue {
  t: Translate
  locale: Locale
  setLocale: (next: Locale) => void
}

const STORAGE_KEY = 'kanweave.locale'

const ZH_CN: Record<string, string> = {
  /* Shared ---------------------------------------------------------- */
  'common.cancel': '取消',
  'common.save': '保存',
  'common.saving': '保存中…',
  'common.add': '添加',
  'common.adding': '添加中…',
  'common.creating': '创建中…',
  'common.delete': '删除',
  'common.remove': '移除',
  'common.close': '关闭',
  'common.dismiss': '关闭提示',
  'common.refresh': '刷新',
  'common.retry': '重试',
  'common.loading': '加载中…',
  'common.searching': '搜索中…',
  'common.sending': '发送中…',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.copyFailed': '复制失败，请手动选择链接复制',
  'common.joining': '加入中…',
  'common.switchLanguage': '切换语言',
  'locale.en': 'EN',
  'locale.zh': '中文',

  /* Errors ---------------------------------------------------------- */
  'err.unknown': '发生未知错误',
  'err.BAD_REQUEST': '请求参数有误',
  'err.UNAUTHORIZED': '登录已过期，请重新登录',
  'err.FORBIDDEN': '没有权限执行该操作',
  'err.NOT_FOUND': '内容不存在或已被删除',
  'err.CONFLICT': '操作冲突，请刷新后重试',
  'err.UNSUPPORTED_MEDIA': '不支持的文件类型',
  'err.TOO_LARGE': '文件超过大小限制',
  'err.VERSION_CONFLICT': '内容已被他人修改，请刷新后重试',
  'err.RATE_LIMITED': '操作过于频繁，请稍后再试',
  'err.INTERNAL': '服务内部错误，请稍后重试',
  'err.MISCONFIGURED': '服务尚未正确配置',
  'err.NETWORK': '网络连接失败，请检查网络后重试',
  'err.ABORTED': '操作已取消',

  /* Roles / priorities --------------------------------------------- */
  'role.owner': '拥有者',
  'role.admin': '管理员',
  'role.member': '成员',
  'role.viewer': '只读成员',
  'priority.none': '无优先级',
  'priority.low': '低',
  'priority.medium': '中',
  'priority.high': '高',
  'priority.urgent': '紧急',

  /* Navigation ------------------------------------------------------ */
  'nav.projects': '项目',
  'auth.signOut': '退出登录',
  'auth.switchAccount': '登录其他账号',
  'auth.switchBack': '返回当前账号',
  'app.bootFailed': '无法连接服务器，请重试。',

  /* Projects -------------------------------------------------------- */
  'project.create': '新建项目',
  'project.createTitle': '新建项目',
  'project.name': '项目名称',
  'project.namePlaceholder': '例如：官网改版',
  'project.nameRequired': '请填写项目名称',
  'project.nameTooLong': '项目名称不能超过 60 个字符',
  'project.key': '项目标识',
  'project.keyPlaceholder': '例如：WEB',
  'project.keyHint': '可选，1–10 位大写字母、数字、下划线或短横线，用于卡片编号。',
  'project.keyInvalid': '项目标识只能使用大写字母、数字、下划线或短横线（1–10 位）',
  'project.description': '项目简介',
  'project.descriptionPlaceholder': '一句话说明这个项目要做什么',
  'project.color': '项目颜色',
  'project.showArchived': '显示已归档',
  'project.empty': '还没有项目，点击右上角 + 新建。',
  'project.emptyAll': '没有已归档的项目。',
  'project.archived': '已归档',
  'project.unarchived': '已取消归档',
  'project.archivedToast': '项目已归档',
  'project.deleted': '项目已删除',
  'project.memberCount': '{count} 位成员',
  'project.cardCount': '{count} 张卡片',

  /* Workspace ------------------------------------------------------- */
  'workspace.emptyTitle': '还没有项目',
  'workspace.emptyHint': '创建第一个项目，然后开始规划栏目与卡片。',

  /* Board ----------------------------------------------------------- */
  'board.title': '看板',
  'board.stats': '进行中 {open} · 共 {total} 张卡片',
  'board.online': '{count} 人在看板',
  'board.signedInAs': '当前登录：{name}',
  'board.addCard': '添加卡片',
  'board.addList': '添加栏目',
  'board.wipLimit': '在制品上限',
  'board.emptyTitle': '还没有栏目',
  'board.emptyHint': '栏目是看板的列，比如「待办」「进行中」「已完成」。',

  /* Lists ----------------------------------------------------------- */
  'list.edit': '编辑栏目',
  'list.editTitle': '编辑栏目',
  'list.name': '栏目名称',
  'list.namePlaceholder': '栏目名称',
  'list.nameRequired': '栏目名称不能为空',
  'list.wip': '在制品上限',
  'list.wipPlaceholder': '不限',
  'list.wipHint': '留空或 0 表示不限制；进行中卡片超出上限时高亮显示。',
  'list.wipInvalid': '请输入有效的数字',
  'list.delete': '删除栏目',
  'list.deleteTitle': '删除栏目',
  'list.deleteMessage': '确定删除该栏目？栏目中的卡片会一并删除。',
  'list.deleteMessageMove': '确定删除「{name}」？其中的卡片会移动到「{target}」。',

  /* Cards ----------------------------------------------------------- */
  'card.drawerTitle': '卡片详情',
  'card.title': '标题',
  'card.titlePlaceholder': '输入卡片标题',
  'card.titleDirtyHint': '回车或失焦保存',
  'card.done': '已完成',
  'card.markDone': '标记完成',
  'card.updatedAt': '更新于 {time}',
  'card.createdBy': '由 {name} 创建于 {time}',
  'card.unknownUser': '未知用户',
  'card.delete': '删除卡片',
  'card.deleteTitle': '删除卡片',
  'card.deleteMessage': '确定删除「{title}」？该操作不可撤销。',
  'card.deleted': '卡片已删除',
  'card.priority': '优先级',
  'card.due': '截止日期',
  'card.assignee': '负责人',
  'card.unassigned': '未指派',
  'card.description': '描述',
  'card.editTab': '编辑',
  'card.previewTab': '预览',
  'card.save': '保存描述',
  'card.descriptionPlaceholder': '支持 Markdown：标题、列表、代码块、表格、链接…',
  'card.noDescription': '暂无描述',
  'card.markdownHint': '支持 Markdown，预览会安全渲染。',
  'card.attachments': '附件',
  'card.noAttachments': '暂无附件',
  'card.comments': '评论',
  'card.noComments': '暂无评论',
  'card.commentPlaceholder': '写下评论…',
  'card.commentHint': 'Ctrl / ⌘ + Enter 发送',
  'card.addComment': '发送评论',

  /* Comments / attachments ----------------------------------------- */
  'comment.delete': '删除评论',
  'attachment.open': '打开 {name}',
  'attachment.download': '下载 {name}',
  'attachment.delete': '删除 {name}',
  'attachment.deleteTitle': '删除附件',
  'attachment.deleteMessage': '确定删除「{name}」？',

  /* Uploader -------------------------------------------------------- */
  'upload.dropHint': '拖拽文件到这里，或',
  'upload.browse': '选择文件',
  'upload.limit': '单个文件最大 {max}',
  'upload.inProgress': '上传中…',
  'upload.incomplete': '上传未完成，请重试',
  'upload.rejectedType': '不支持的文件类型：{name}',
  'upload.empty': '文件为空：{name}',
  'upload.tooLarge': '文件超过大小限制（{max}）：{name}',
  'upload.failed': '上传失败',
  'upload.cancel': '取消上传',

  /* Settings -------------------------------------------------------- */
  'settings.title': '项目设置 · {name}',
  'settings.titleShort': '设置',
  'settings.hint': '管理项目信息、成员与邀请链接。',
  'settings.saved': '已保存',
  'settings.tab.general': '常规',
  'settings.tab.members': '成员',
  'settings.tab.invites': '邀请',
  'settings.dangerZone': '危险操作',
  'settings.archive': '归档项目',
  'settings.unarchive': '取消归档',
  'settings.archiveHint': '归档后项目仍在列表中（勾选「显示已归档」可见），但不在默认视图里。',
  'settings.deleteProject': '删除项目',
  'settings.deleteHint': '删除项目会同时删除其中的栏目、卡片、评论与附件，且无法恢复。',
  'settings.deleteMessage': '确定删除项目「{name}」？该操作不可撤销。',

  /* Members --------------------------------------------------------- */
  'members.title': '成员',
  'members.person': '成员',
  'members.role': '角色',
  'members.actions': '操作',
  'members.me': '我',
  'members.roleFor': '更改 {name} 的角色',
  'members.remove': '移除 {name}',
  'members.empty': '暂无成员',
  'members.addExisting': '添加已有用户',
  'members.searchPlaceholder': '搜索姓名或邮箱…',
  'members.noResults': '没有找到用户',
  'members.directoryEmpty': '还没有可邀请的注册用户，可先生成邀请链接。',
  'members.dingtalkAccount': '钉钉账号',
  'members.removeTitle': '移除成员',
  'members.removeMessage': '确定将「{name}」移出项目？',
  'members.roleChanged': '已更新 {name} 的角色',
  'members.removed': '已移除 {name}',
  'members.added': '已添加 {name}',

  /* Invites --------------------------------------------------------- */
  'invites.title': '邀请链接',
  'invites.role': '邀请角色',
  'invites.create': '创建邀请链接',
  'invites.created': '已创建邀请链接，复制后发送给对方：',
  'invites.link': '邀请链接',
  'invites.empty': '暂无邀请链接',
  'invites.expiresAt': '有效期至 {time}',
  'invites.noExpiry': '永久有效',
  'invites.uses': '已使用 {used}/{max}',
  'invites.usesUnlimited': '已使用 {used} 次',
  'invites.unusable': '已失效',
  'invites.revoke': '撤销邀请',
  'invites.revoked': '邀请已撤销',
  'invite.title': '加入项目',
  'invite.joined': '已加入项目',
  'invite.roleOffer': '加入后的角色：{role}',
  'invite.unusable': '该邀请链接不可用',
  'invite.join': '加入项目',
  'invite.signInFirst': '登录后将自动加入受邀项目。',
  'invite.skip': '先不加入',
  'invite.registerHint': '创建账号后即可加入该项目。',
  'invite.nameOptional': '姓名（可选）',
  'invite.createAndJoin': '创建账号并加入',
  'invite.creatingAccount': '创建中…',
  'invite.haveAccount': '已有账号？',
  'invite.needAccount': '还没有账号？',
  'invite.createAccount': '创建账号',

  /* Auth ------------------------------------------------------------ */
  'login.title': '登录 KanWeave',
  'login.subtitle': '继续管理你的项目与看板。',
  'login.email': '邮箱',
  'login.emailPlaceholder': 'you@example.com',
  'login.password': '密码',
  'login.passwordPlaceholder': '输入密码',
  'login.submit': '登录',
  'login.signingIn': '登录中…',
  'login.emailRequired': '请输入邮箱',
  'login.passwordRequired': '请输入密码',
  'login.passwordTooShort': '密码至少 8 位',
  'login.invalidCredentials': '邮箱或密码不正确',
  'login.or': '或',
  'login.dingtalk': '使用钉钉登录',
  'login.dingtalkWaiting': '等待钉钉授权…',
  'login.dingtalkUnavailable': '未配置钉钉登录',
  'login.dingtalkDenied': '钉钉授权被拒绝',
  'login.dingtalkExpired': '授权已过期，请重试',
  'login.dingtalkFailed': '钉钉登录失败，请重试',
  'login.bootstrapHint': '首次使用？刷新页面即可创建管理员账号。',
  'login.cookieHint': '登录状态由 HttpOnly Cookie 保存。',
  'login.noMethod': '当前未启用任何登录方式。',
  'bootstrap.title': '创建管理员账号',
  'bootstrap.subtitle': '首次运行：创建第一个账号，它将成为项目的拥有者。',
  'bootstrap.name': '姓名',
  'bootstrap.namePlaceholder': '你的名字',
  'bootstrap.password': '密码',
  'bootstrap.passwordPlaceholder': '至少 8 位',
  'bootstrap.confirm': '确认密码',
  'bootstrap.nameRequired': '请输入昵称',
  'bootstrap.passwordMismatch': '两次输入的密码不一致',
  'bootstrap.exists': '该邮箱已注册，请直接登录。',
  'bootstrap.footer': '密码至少 8 位。',
  'bootstrap.submit': '创建账号',
  'bootstrap.creating': '创建中…',
  'register.link': '还没有账号？注册',
  'register.title': '注册账号',
  'register.subtitle': '注册后即可加入被邀请的项目。',
  'register.name': '昵称',
  'register.namePlaceholder': '团队里显示的名字',
  'register.submit': '注册并登录',
  'register.submitting': '注册中…',
  'register.emailTaken': '该邮箱已注册，请直接登录。',
  'register.closed': '本站未开放自助注册，请联系管理员或使用钉钉登录。',
  'register.backToLogin': '已有账号？返回登录',
  'register.hint': '注册的账号默认没有任何项目权限，需要项目管理员邀请。',
}

const EN_US: Record<string, string> = {
  /* Shared ---------------------------------------------------------- */
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.saving': 'Saving…',
  'common.add': 'Add',
  'common.adding': 'Adding…',
  'common.creating': 'Creating…',
  'common.delete': 'Delete',
  'common.remove': 'Remove',
  'common.close': 'Close',
  'common.dismiss': 'Dismiss',
  'common.refresh': 'Refresh',
  'common.retry': 'Retry',
  'common.loading': 'Loading…',
  'common.searching': 'Searching…',
  'common.sending': 'Sending…',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.copyFailed': 'Copy failed — select the link and copy it manually',
  'common.joining': 'Joining…',
  'common.switchLanguage': 'Switch language',
  'locale.en': 'EN',
  'locale.zh': '中文',

  /* Errors ---------------------------------------------------------- */
  'err.unknown': 'Something went wrong',
  'err.BAD_REQUEST': 'Invalid request',
  'err.UNAUTHORIZED': 'Your session expired — please sign in again',
  'err.FORBIDDEN': 'You are not allowed to do that',
  'err.NOT_FOUND': 'Not found or already deleted',
  'err.CONFLICT': 'Conflicting change — refresh and try again',
  'err.UNSUPPORTED_MEDIA': 'Unsupported file type',
  'err.TOO_LARGE': 'File is too large',
  'err.VERSION_CONFLICT': 'Someone else changed this — refresh and try again',
  'err.RATE_LIMITED': 'Too many requests — try again shortly',
  'err.INTERNAL': 'Server error — try again later',
  'err.MISCONFIGURED': 'Server is not configured yet',
  'err.NETWORK': 'Network request failed — check your connection',
  'err.ABORTED': 'Cancelled',

  /* Roles / priorities --------------------------------------------- */
  'role.owner': 'Owner',
  'role.admin': 'Admin',
  'role.member': 'Member',
  'role.viewer': 'Viewer',
  'priority.none': 'No priority',
  'priority.low': 'Low',
  'priority.medium': 'Medium',
  'priority.high': 'High',
  'priority.urgent': 'Urgent',

  /* Navigation ------------------------------------------------------ */
  'nav.projects': 'Projects',
  'auth.signOut': 'Sign out',
  'auth.switchAccount': 'Sign in as someone else',
  'auth.switchBack': 'Back to current account',
  'app.bootFailed': 'Could not reach the server — please retry.',

  /* Projects -------------------------------------------------------- */
  'project.create': 'New project',
  'project.createTitle': 'New project',
  'project.name': 'Project name',
  'project.namePlaceholder': 'e.g. Website relaunch',
  'project.nameRequired': 'Project name is required',
  'project.nameTooLong': 'Project name must be 60 characters or fewer',
  'project.key': 'Project key',
  'project.keyPlaceholder': 'e.g. WEB',
  'project.keyHint': 'Optional. 1–10 uppercase letters, digits, underscores or dashes; used in card numbers.',
  'project.keyInvalid': 'Key must be 1–10 uppercase letters, digits, underscores or dashes',
  'project.description': 'Description',
  'project.descriptionPlaceholder': 'One sentence about what this project is for',
  'project.color': 'Project colour',
  'project.showArchived': 'Show archived',
  'project.empty': 'No projects yet — use + to create one.',
  'project.emptyAll': 'No archived projects.',
  'project.archived': 'Archived',
  'project.unarchived': 'Project unarchived',
  'project.archivedToast': 'Project archived',
  'project.deleted': 'Project deleted',
  'project.memberCount': '{count} members',
  'project.cardCount': '{count} cards',

  /* Workspace ------------------------------------------------------- */
  'workspace.emptyTitle': 'No projects yet',
  'workspace.emptyHint': 'Create your first project, then start shaping lists and cards.',

  /* Board ----------------------------------------------------------- */
  'board.title': 'Board',
  'board.stats': '{open} open · {total} cards',
  'board.online': '{count} viewing',
  'board.signedInAs': 'Signed in as {name}',
  'board.addCard': 'Add card',
  'board.addList': 'Add list',
  'board.wipLimit': 'WIP limit',
  'board.emptyTitle': 'No lists yet',
  'board.emptyHint': 'Lists are the columns of the board — e.g. To do, In progress, Done.',

  /* Lists ----------------------------------------------------------- */
  'list.edit': 'Edit list',
  'list.editTitle': 'Edit list',
  'list.name': 'List name',
  'list.namePlaceholder': 'List name',
  'list.nameRequired': 'List name is required',
  'list.wip': 'WIP limit',
  'list.wipPlaceholder': 'Unlimited',
  'list.wipHint': 'Leave empty or 0 for no limit; the column highlights when open cards exceed it.',
  'list.wipInvalid': 'Enter a valid number',
  'list.delete': 'Delete list',
  'list.deleteTitle': 'Delete list',
  'list.deleteMessage': 'Delete this list? Its cards are deleted too.',
  'list.deleteMessageMove': 'Delete “{name}”? Its cards move to “{target}”.',

  /* Cards ----------------------------------------------------------- */
  'card.drawerTitle': 'Card',
  'card.title': 'Title',
  'card.titlePlaceholder': 'Card title',
  'card.titleDirtyHint': 'Enter or blur to save',
  'card.done': 'Done',
  'card.markDone': 'Mark done',
  'card.updatedAt': 'Updated {time}',
  'card.createdBy': 'Created by {name} on {time}',
  'card.unknownUser': 'Unknown user',
  'card.delete': 'Delete card',
  'card.deleteTitle': 'Delete card',
  'card.deleteMessage': 'Delete “{title}”? This cannot be undone.',
  'card.deleted': 'Card deleted',
  'card.priority': 'Priority',
  'card.due': 'Due date',
  'card.assignee': 'Assignee',
  'card.unassigned': 'Unassigned',
  'card.description': 'Description',
  'card.editTab': 'Edit',
  'card.previewTab': 'Preview',
  'card.save': 'Save description',
  'card.descriptionPlaceholder': 'Markdown supported: headings, lists, code blocks, tables, links…',
  'card.noDescription': 'No description',
  'card.markdownHint': 'Markdown supported; the preview is rendered safely.',
  'card.attachments': 'Attachments',
  'card.noAttachments': 'No attachments',
  'card.comments': 'Comments',
  'card.noComments': 'No comments',
  'card.commentPlaceholder': 'Write a comment…',
  'card.commentHint': 'Ctrl / ⌘ + Enter to send',
  'card.addComment': 'Post comment',

  /* Comments / attachments ----------------------------------------- */
  'comment.delete': 'Delete comment',
  'attachment.open': 'Open {name}',
  'attachment.download': 'Download {name}',
  'attachment.delete': 'Delete {name}',
  'attachment.deleteTitle': 'Delete attachment',
  'attachment.deleteMessage': 'Delete “{name}”?',

  /* Uploader -------------------------------------------------------- */
  'upload.dropHint': 'Drop files here, or',
  'upload.browse': 'choose files',
  'upload.limit': 'Up to {max} per file',
  'upload.inProgress': 'Uploading…',
  'upload.incomplete': 'Upload did not finish — please retry',
  'upload.rejectedType': 'Unsupported file type: {name}',
  'upload.empty': 'File is empty: {name}',
  'upload.tooLarge': 'File exceeds the limit ({max}): {name}',
  'upload.failed': 'Upload failed',
  'upload.cancel': 'Cancel upload',

  /* Settings -------------------------------------------------------- */
  'settings.title': 'Project settings · {name}',
  'settings.titleShort': 'Settings',
  'settings.hint': 'Manage project details, members and invite links.',
  'settings.saved': 'Saved',
  'settings.tab.general': 'General',
  'settings.tab.members': 'Members',
  'settings.tab.invites': 'Invites',
  'settings.dangerZone': 'Danger zone',
  'settings.archive': 'Archive project',
  'settings.unarchive': 'Unarchive',
  'settings.archiveHint': 'Archived projects stay in the list (visible with “Show archived”) but leave the default view.',
  'settings.deleteProject': 'Delete project',
  'settings.deleteHint': 'Deleting a project also deletes its lists, cards, comments and attachments. This cannot be undone.',
  'settings.deleteMessage': 'Delete the project “{name}”? This cannot be undone.',

  /* Members --------------------------------------------------------- */
  'members.title': 'Members',
  'members.person': 'Member',
  'members.role': 'Role',
  'members.actions': 'Actions',
  'members.me': 'me',
  'members.roleFor': 'Change the role of {name}',
  'members.remove': 'Remove {name}',
  'members.empty': 'No members',
  'members.addExisting': 'Add an existing user',
  'members.searchPlaceholder': 'Search by name or email…',
  'members.noResults': 'No users found',
  'members.directoryEmpty': 'No registered accounts to invite yet — create an invite link instead.',
  'members.dingtalkAccount': 'DingTalk account',
  'members.removeTitle': 'Remove member',
  'members.removeMessage': 'Remove “{name}” from this project?',
  'members.roleChanged': 'Updated the role of {name}',
  'members.removed': 'Removed {name}',
  'members.added': 'Added {name}',

  /* Invites --------------------------------------------------------- */
  'invites.title': 'Invite links',
  'invites.role': 'Invite role',
  'invites.create': 'Create invite link',
  'invites.created': 'Invite link created — copy and send it:',
  'invites.link': 'Invite link',
  'invites.empty': 'No invite links',
  'invites.expiresAt': 'Expires {time}',
  'invites.noExpiry': 'Never expires',
  'invites.uses': 'Used {used}/{max}',
  'invites.usesUnlimited': 'Used {used} times',
  'invites.unusable': 'No longer usable',
  'invites.revoke': 'Revoke invite',
  'invites.revoked': 'Invite revoked',
  'invite.title': 'Join project',
  'invite.joined': 'Joined the project',
  'invite.roleOffer': 'Role after joining: {role}',
  'invite.unusable': 'This invite link cannot be used',
  'invite.join': 'Join project',
  'invite.signInFirst': 'Sign in and you will join the invited project.',
  'invite.skip': 'Not now',
  'invite.registerHint': 'Create an account to join this project.',
  'invite.nameOptional': 'Name (optional)',
  'invite.createAndJoin': 'Create account and join',
  'invite.creatingAccount': 'Creating…',
  'invite.haveAccount': 'Already have an account?',
  'invite.needAccount': 'No account yet?',
  'invite.createAccount': 'Create an account',

  /* Auth ------------------------------------------------------------ */
  'login.title': 'Sign in to KanWeave',
  'login.subtitle': 'Pick up your projects and boards.',
  'login.email': 'Email',
  'login.emailPlaceholder': 'you@example.com',
  'login.password': 'Password',
  'login.passwordPlaceholder': 'Your password',
  'login.submit': 'Sign in',
  'login.signingIn': 'Signing in…',
  'login.emailRequired': 'Email is required',
  'login.passwordRequired': 'Password is required',
  'login.passwordTooShort': 'Password must be at least 8 characters',
  'login.invalidCredentials': 'Wrong email or password',
  'login.or': 'or',
  'login.dingtalk': 'Sign in with DingTalk',
  'login.dingtalkWaiting': 'Waiting for DingTalk authorisation…',
  'login.dingtalkUnavailable': 'DingTalk sign-in is not configured',
  'login.dingtalkDenied': 'DingTalk authorisation was denied',
  'login.dingtalkExpired': 'Authorisation expired — please try again',
  'login.dingtalkFailed': 'DingTalk sign-in failed — please try again',
  'login.bootstrapHint': 'First time here? Reload the page to create the admin account.',
  'login.cookieHint': 'Your session is kept in an HttpOnly cookie.',
  'login.noMethod': 'No sign-in method is enabled.',
  'bootstrap.title': 'Create the admin account',
  'bootstrap.subtitle': 'First run: create the first account, which becomes the project owner.',
  'bootstrap.name': 'Name',
  'bootstrap.namePlaceholder': 'Your name',
  'bootstrap.password': 'Password',
  'bootstrap.passwordPlaceholder': 'At least 8 characters',
  'bootstrap.confirm': 'Confirm password',
  'bootstrap.nameRequired': 'Enter a display name',
  'bootstrap.passwordMismatch': 'The two passwords do not match',
  'bootstrap.exists': 'That email is already registered — sign in instead.',
  'bootstrap.footer': 'At least 8 characters.',
  'bootstrap.submit': 'Create account',
  'bootstrap.creating': 'Creating…',
  'register.link': 'No account yet? Register',
  'register.title': 'Create an account',
  'register.subtitle': 'Register first, then join the projects you are invited to.',
  'register.name': 'Display name',
  'register.namePlaceholder': 'How teammates see you',
  'register.submit': 'Register and sign in',
  'register.submitting': 'Registering…',
  'register.emailTaken': 'That email is already registered — sign in instead.',
  'register.closed': 'Self-service registration is closed here — ask an administrator or use DingTalk.',
  'register.backToLogin': 'Already registered? Sign in',
  'register.hint': 'A new account has no project access until a project administrator invites it.',
}

const DICTIONARIES: Record<Locale, Record<string, string>> = {
  'zh-CN': ZH_CN,
  'en-US': EN_US,
}

function readStoredLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'zh-CN' || stored === 'en-US') return stored
  } catch {
    /* private mode / disabled storage: fall through */
  }
  return DEFAULT_LOCALE
}

export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = vars[key]
    return value === undefined || value === null ? match : String(value)
  })
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readStoredLocale())

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }, [])

  const t = useMemo<Translate>(() => {
    const primary = DICTIONARIES[locale]
    const fallback = DICTIONARIES[DEFAULT_LOCALE]
    return (key, vars) => {
      const template = primary[key] ?? fallback[key]
      if (template === undefined) return key
      return interpolate(template, vars)
    }
  }, [locale])

  const value = useMemo<I18nValue>(() => ({ t, locale, setLocale }), [t, locale, setLocale])

  return createElement(I18nContext.Provider, { value }, children)
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n must be used inside <I18nProvider>')
  return value
}

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

export function formatDateTime(iso: string, locale: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  } catch {
    return date.toLocaleString()
  }
}

export function formatBytes(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  let formatted: string
  try {
    formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)
  } catch {
    formatted = String(Math.round(value * 10) / 10)
  }
  return `${formatted} ${units[unit]}`
}

/** Human message for an API failure, using `err.<CODE>` entries. */
export function describeError(failure: ApiFailure, t: Translate): string {
  const code = (failure.code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (code) {
    const key = `err.${code}`
    const mapped = t(key)
    if (mapped !== key) return mapped
  }
  if (failure.message) return failure.message
  return t('err.unknown')
}
