import { Field, Label, Description, Select } from "@headlessui/react"

interface ServerDropDownProps {
  serverUrl:  string;
  setServerUrl: (event: string) => void;
}

export function ServerDropdown({serverUrl, setServerUrl}: ServerDropDownProps) {
  return (
    <Field className="flex flex-col gap-1">
      <Label className="text-gray-400 text-sm">Select a Server</Label>
      <Description className="text-gray-500 text-xs mb-2">{serverUrl}</Description>
      <Select 
        name="server select" 
        aria-label="Select a Server" 
        onChange={(e) => setServerUrl(e.target.value)}
        className="px-2 py-2 bg-gray-950 border border-gray-700 rounded text-gray-200 text-sm focus:outline-none focus:border-blue-500"
      >
        <option value={"http://localhost:9000"}>Development Server</option>
        <option value={"http://localhost:3001"}>Docker Server 1</option>
        <option value={"http://localhost:3002"}>Docker Server 2</option>
        <option value={"http://localhost:3003"}>Docker Server 3</option>
      </Select>
    </Field>
  )
}