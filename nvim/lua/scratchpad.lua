-- Pico Scratchpad for Neovim: `:Scratch [name]` opens a live-synced note buffer.
-- Edits are sent ~150 ms after typing stops; other devices' edits stream in over SSE (curl).
-- Every save names the server revision it was based on; if the note changed elsewhere in between,
-- our text is kept as a "conflict" copy and the server version is loaded.
local M = {}
local cfg = { url = "http://127.0.0.1:8787", debounce = 150 }
local id = string.format("nvim%x%x", vim.uv.hrtime(), vim.fn.getpid())
local bufs = {} -- name -> bufnr (synced buffers only)
local last = {} -- bufnr -> text last sent or received (skips echoes and no-op changes)
local revs = {} -- bufnr -> server revision `last` is based on
local timers = {} -- bufnr -> debounce timer
local jobs = {} -- bufnr -> PUT on its way (one at a time per buffer)
local sse
local applying = false -- true while we write a remote edit into a buffer

local function enc(s)
  return (s:gsub("[^%w%.%-_~]", function(c) return string.format("%%%02X", c:byte()) end))
end

local function file_url(name) return cfg.url .. "/api/files/" .. enc(name) end

local function split_name(name)
  local base, ext = name:match("^(.-)(%.[^.]*)$")
  return base or name, ext or ""
end

local function conflict_name(name)
  local base, ext = split_name(name)
  return base:sub(1, 60) .. " conflict " .. os.date("%Y-%m-%d %H%M%S") .. ext
end

-- curl's output is body, then "\n<status> <x-rev header>"
local function parse(r)
  local body, code, rev = (r.stdout or ""):match("^(.*)\n(%d+) (%S*)$")
  return tonumber(code) or 0, body or "", rev ~= "" and rev or nil
end

-- Run curl async; cb(code, body, rev) runs on the main loop
local function curl(args, stdin, cb)
  local cmd = vim.list_extend({ "curl", "-sS", "-w", "\n%{http_code} %header{x-rev}", "-H", "X-Client: " .. id }, args)
  return vim.system(cmd, { stdin = stdin, text = true }, cb and function(r)
    local code, body, rev = parse(r)
    vim.schedule(function() cb(code, body, rev) end)
  end)
end

-- PUT args; If-Match the known revision, or only create when we don't know one
local function put_args(name, rev)
  return { "-X", "PUT", "-H", rev and ("If-Match: " .. rev) or "If-None-Match: *", "--data-binary", "@-", file_url(name) }
end

local function buf_text(buf) return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n") end

local function apply(buf, text)
  last[buf] = text
  if buf_text(buf) == text then return end
  local cursors = {}
  for _, w in ipairs(vim.fn.win_findbuf(buf)) do cursors[w] = vim.api.nvim_win_get_cursor(w) end
  applying = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(text, "\n", { plain = true }))
  applying = false
  local n = vim.api.nvim_buf_line_count(buf)
  for w, c in pairs(cursors) do pcall(vim.api.nvim_win_set_cursor, w, { math.min(c[1], n), c[2] }) end
  vim.bo[buf].modified = false
end

local function name_of(buf)
  for name, b in pairs(bufs) do if b == buf then return name end end
end

local function pending(buf) return timers[buf] and timers[buf]:is_active() end
local function busy(buf) return pending(buf) or jobs[buf] ~= nil end -- unsent or unconfirmed local edits

-- The note was deleted elsewhere: stop syncing, keep the text in a buffer that can't recreate it
local function detach(buf, name)
  if bufs[name] == buf then bufs[name] = nil end
  last[buf], revs[buf] = nil, nil
  if timers[buf] then timers[buf]:stop() end
  pcall(vim.api.nvim_buf_set_name, buf, "scratch://" .. name .. " (deleted)")
  vim.bo[buf].buftype = "nofile"
  vim.notify("scratchpad: " .. name .. " was deleted on another device; this buffer is no longer synced"
    .. " (:ScratchSnapshot keeps a copy)", vim.log.levels.WARN)
end

local fetch

-- The note changed elsewhere since our revision: save our text as a new note, show the server version
local function conflict(buf, name, code, body)
  local copy = conflict_name(name)
  curl(put_args(copy, nil), buf_text(buf), function(c)
    if c ~= 204 then vim.notify("scratchpad: saving conflict copy failed (" .. c .. ")", vim.log.levels.ERROR) end
  end)
  if timers[buf] then timers[buf]:stop() end
  local ok, cur = pcall(vim.json.decode, body)
  if code == 409 and ok and type(cur) == "table" and type(cur.text) == "string" then
    revs[buf] = cur.rev
    apply(buf, cur.text)
  elseif code == 409 then
    return detach(buf, name) -- deleted meanwhile
  else
    revs[buf] = nil
    fetch(name)
  end
  vim.notify("scratchpad: " .. name .. " was changed on another device at the same time; your version was saved as "
    .. copy, vim.log.levels.WARN)
end

local function send(buf)
  local name, text = name_of(buf), buf_text(buf)
  vim.bo[buf].modified = false
  if not name or text == last[buf] or jobs[buf] then return end -- in flight: re-sent when it returns
  last[buf] = text
  jobs[buf] = curl(put_args(name, revs[buf]), text, function(code, body, rev)
    jobs[buf] = nil
    if bufs[name] ~= buf then return end -- closed or deleted meanwhile
    if code == 204 then
      revs[buf] = rev
      send(buf) -- typing that happened while this save was on its way
    elseif code == 409 or code == 412 then
      conflict(buf, name, code, body)
    else
      vim.notify("scratchpad: save failed (" .. code .. ")", vim.log.levels.WARN)
    end
  end)
  return jobs[buf]
end

-- Neovim is exiting, so callbacks won't run: finish this buffer's saves synchronously
local function send_sync(buf)
  local name = name_of(buf)
  if not name then return end
  local code = 204
  if jobs[buf] then
    local c, _, rev = parse(jobs[buf]:wait(2000))
    code = c
    if code == 204 then revs[buf] = rev end
  end
  local text = buf_text(buf)
  if code == 204 and text == last[buf] then return end
  if code == 204 then code = parse(curl(put_args(name, revs[buf]), text):wait(2000)) end
  if code == 409 or code == 412 then curl(put_args(conflict_name(name), nil), text):wait(2000) end
end

fetch = function(name)
  curl({ file_url(name) }, nil, function(code, body, rev)
    local buf = bufs[name]
    if buf and code == 200 and not busy(buf) then
      revs[buf] = rev
      apply(buf, body)
    end
  end)
end

local function on_event(ev)
  if ev.from == id then return end
  local buf = bufs[ev.name]
  if not buf then return end
  if ev.type == "change" and not busy(buf) then -- unsent local typing: the save will report the conflict
    revs[buf] = ev.rev
    apply(buf, ev.text)
  elseif ev.type == "delete" then
    detach(buf, ev.name)
  end
end

local function connect()
  if sse then return end
  local partial = ""
  sse = vim.system({ "curl", "-sN", cfg.url .. "/api/events" }, {
    stdout = function(_, data)
      if not data then return end
      partial = partial .. data
      local lines = vim.split(partial, "\n", { plain = true })
      partial = table.remove(lines)
      vim.schedule(function()
        for _, l in ipairs(lines) do
          if l == ": hello" then -- (re)connected: catch up on anything missed
            for name in pairs(bufs) do fetch(name) end
          elseif l:sub(1, 6) == "data: " then
            local ok, ev = pcall(vim.json.decode, l:sub(7))
            if ok then on_event(ev) end
          end
        end
      end)
    end,
  }, function()
    sse = nil
    if next(bufs) then vim.defer_fn(connect, 2000) end -- reconnect while notes are open
  end)
end

local function list_files()
  local r = vim.system({ "curl", "-sSf", cfg.url .. "/api/files" }, { text = true }):wait()
  local ok, files = pcall(vim.json.decode, r.stdout or "")
  return ok and files or {}
end

function M.open(name)
  if bufs[name] and vim.api.nvim_buf_is_valid(bufs[name]) then return vim.api.nvim_set_current_buf(bufs[name]) end
  local buf = vim.api.nvim_create_buf(true, false)
  vim.api.nvim_buf_set_name(buf, "scratch://" .. name)
  vim.bo[buf].buftype = "acwrite"
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = vim.filetype.match({ filename = name }) or "text"
  vim.b[buf].scratch_name = name
  bufs[name] = buf
  last[buf] = ""
  vim.api.nvim_set_current_buf(buf)

  local group = vim.api.nvim_create_augroup("scratchpad_" .. buf, { clear = true })
  timers[buf] = vim.uv.new_timer()
  vim.api.nvim_buf_attach(buf, false, {
    on_lines = function()
      if timers[buf] and not applying then timers[buf]:start(cfg.debounce, 0, vim.schedule_wrap(function() send(buf) end)) end
    end,
  })
  vim.api.nvim_create_autocmd("BufWriteCmd", { group = group, buffer = buf, callback = function() send(buf) end })
  vim.api.nvim_create_autocmd("BufWipeout", {
    group = group, buffer = buf,
    callback = function()
      if pending(buf) then send(buf) end
      if timers[buf] then timers[buf]:close() end
      if bufs[name] == buf then bufs[name] = nil end
      last[buf], revs[buf], timers[buf], jobs[buf] = nil, nil, nil, nil
      if not next(bufs) and sse then sse:kill(15) end
    end,
  })

  curl({ file_url(name) }, nil, function(code, body, rev)
    if code == 200 then
      revs[buf] = rev
      apply(buf, body)
    elseif code == 404 then
      curl(put_args(name, nil), "", function(c, _, r)
        if c == 204 then revs[buf] = r elseif c == 412 then fetch(name) end -- 412: created elsewhere meanwhile
      end)
    else
      vim.notify("scratchpad: cannot reach " .. cfg.url .. " (" .. code .. ")", vim.log.levels.ERROR)
    end
  end)
  connect()
end

-- Save the buffer's current text as an ordinary local file, independent of the server
function M.snapshot(path)
  local buf = vim.api.nvim_get_current_buf()
  local name = vim.b[buf].scratch_name
  if not name then return vim.notify("not a scratchpad buffer") end
  local base, ext = split_name(name)
  local default = base .. "-" .. os.date("%Y-%m-%d_%H%M") .. ext
  path = (path and path ~= "") and vim.fn.expand(path) or default
  if vim.fn.isdirectory(path) == 1 then path = path .. "/" .. default end
  if vim.fn.writefile(vim.api.nvim_buf_get_lines(buf, 0, -1, false), path) ~= 0 then
    return vim.notify("scratchpad: cannot write " .. path, vim.log.levels.ERROR)
  end
  vim.notify("scratchpad: saved " .. vim.fn.fnamemodify(path, ":p"))
end

function M.setup(opts)
  cfg = vim.tbl_extend("force", cfg, opts or {})
  vim.api.nvim_create_user_command("Scratch", function(a)
    if a.args ~= "" then return M.open(a.args) end
    vim.ui.select(list_files(), { prompt = "Scratchpad" }, function(choice) if choice then M.open(choice) end end)
  end, { nargs = "?", complete = function(lead)
    return vim.tbl_filter(function(f) return f:find(lead, 1, true) == 1 end, list_files())
  end })
  vim.api.nvim_create_user_command("ScratchSnapshot", function(a) M.snapshot(a.args) end, { nargs = "?", complete = "file" })
  vim.api.nvim_create_user_command("ScratchDelete", function()
    local buf = vim.api.nvim_get_current_buf()
    local name = name_of(buf)
    if not name then return vim.notify("not a scratchpad buffer") end
    if vim.fn.confirm("Delete " .. name .. " on all devices?", "&Yes\n&No", 2) ~= 1 then return end
    bufs[name] = nil -- stop syncing first, so unsent typing can't recreate it
    curl({ "-X", "DELETE", file_url(name) }, nil, function()
      pcall(vim.api.nvim_buf_delete, buf, { force = true })
    end)
  end, {})
  vim.api.nvim_create_autocmd("VimLeavePre", {
    callback = function()
      for buf in pairs(timers) do send_sync(buf) end -- send unsent typing, nvim is exiting
      if sse then sse:kill(15) end
    end,
  })
end

return M
