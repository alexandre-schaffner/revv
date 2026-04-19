import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@rev/ui/components/ui/button";
import { Badge } from "@rev/ui/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@rev/ui/components/ui/card";
import { Input } from "@rev/ui/components/ui/input";
import { Textarea } from "@rev/ui/components/ui/textarea";
import { Checkbox } from "@rev/ui/components/ui/checkbox";
import { Switch } from "@rev/ui/components/ui/switch";
import { Slider } from "@rev/ui/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@rev/ui/components/ui/select";
import { Separator } from "@rev/ui/components/ui/separator";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@rev/ui/components/ui/avatar";
import { Alert, AlertTitle, AlertDescription } from "@rev/ui/components/ui/alert";
import { Skeleton } from "@rev/ui/components/ui/skeleton";
import { Spinner } from "@rev/ui/components/ui/spinner";
import { Kbd } from "@rev/ui/components/ui/kbd";
import { Toggle } from "@rev/ui/components/ui/toggle";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@rev/ui/components/ui/tabs";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@rev/ui/components/ui/accordion";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@rev/ui/components/ui/tooltip";
import {
  AlertCircle,
  Bold,
  Check,
  Info,
  Italic,
  Mail,
  Terminal,
  Underline,
} from "lucide-react";

export const Route = createFileRoute("/design")({
  component: DesignPage,
});

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Showcase({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {label}
      </p>
      {children}
    </div>
  );
}

function DesignPage() {
  return (
    <TooltipProvider>
      <div className="h-full overflow-y-auto">
        <div className="max-w-5xl mx-auto px-8 py-10 space-y-12">
          <header>
            <h1 className="text-2xl font-bold tracking-tight">Design System</h1>
            <p className="text-muted-foreground mt-1">
              Component showcase for <code className="text-xs bg-muted px-1.5 py-0.5 rounded">@rev/ui</code>
            </p>
          </header>

          {/* ── Colors ── */}
          <Section title="Colors">
            <div className="grid grid-cols-2 gap-6">
              <Showcase label="Theme colors">
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { name: "Background", cls: "bg-background border" },
                    { name: "Foreground", cls: "bg-foreground" },
                    { name: "Primary", cls: "bg-primary" },
                    { name: "Secondary", cls: "bg-secondary border" },
                    { name: "Muted", cls: "bg-muted border" },
                    { name: "Accent", cls: "bg-accent border" },
                    { name: "Destructive", cls: "bg-destructive" },
                    { name: "Card", cls: "bg-card border" },
                  ].map(({ name, cls }) => (
                    <div key={name} className="space-y-1.5">
                      <div className={`h-10 rounded-md ${cls}`} />
                      <p className="text-[10px] text-muted-foreground text-center">{name}</p>
                    </div>
                  ))}
                </div>
              </Showcase>

              <Showcase label="Semantic colors">
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { name: "Border", cls: "bg-border" },
                    { name: "Input", cls: "bg-input" },
                    { name: "Ring", cls: "bg-ring" },
                    { name: "Popover", cls: "bg-popover border" },
                  ].map(({ name, cls }) => (
                    <div key={name} className="space-y-1.5">
                      <div className={`h-10 rounded-md ${cls}`} />
                      <p className="text-[10px] text-muted-foreground text-center">{name}</p>
                    </div>
                  ))}
                </div>
              </Showcase>
            </div>
          </Section>

          {/* ── Typography ── */}
          <Section title="Typography">
            <Card>
              <CardContent className="pt-6 space-y-3">
                <p className="text-4xl font-bold tracking-tight">Heading 1</p>
                <p className="text-3xl font-semibold tracking-tight">Heading 2</p>
                <p className="text-2xl font-semibold tracking-tight">Heading 3</p>
                <p className="text-xl font-semibold">Heading 4</p>
                <p className="text-lg font-medium">Large text</p>
                <p className="text-base">Body text - The quick brown fox jumps over the lazy dog.</p>
                <p className="text-sm text-muted-foreground">Small / muted text</p>
                <p className="text-xs text-muted-foreground">Extra small caption</p>
                <p className="font-mono text-sm">Monospace: const x = 42;</p>
              </CardContent>
            </Card>
          </Section>

          <Separator />

          {/* ── Buttons ── */}
          <Section title="Buttons">
            <div className="grid grid-cols-2 gap-6">
              <Showcase label="Variants">
                <div className="flex flex-wrap gap-2">
                  <Button variant="default">Default</Button>
                  <Button variant="secondary">Secondary</Button>
                  <Button variant="outline">Outline</Button>
                  <Button variant="ghost">Ghost</Button>
                  <Button variant="destructive">Destructive</Button>
                  <Button variant="link">Link</Button>
                </div>
              </Showcase>

              <Showcase label="Sizes">
                <div className="flex items-center gap-2">
                  <Button size="sm">Small</Button>
                  <Button size="default">Default</Button>
                  <Button size="lg">Large</Button>
                  <Button size="icon"><Mail className="h-4 w-4" /></Button>
                </div>
              </Showcase>

              <Showcase label="States">
                <div className="flex flex-wrap gap-2">
                  <Button>Enabled</Button>
                  <Button disabled>Disabled</Button>
                  <Button variant="outline" disabled>Disabled outline</Button>
                </div>
              </Showcase>

              <Showcase label="With icons">
                <div className="flex flex-wrap gap-2">
                  <Button><Mail className="mr-2 h-4 w-4" /> Login with Email</Button>
                  <Button variant="outline"><Check className="mr-2 h-4 w-4" /> Approve</Button>
                  <Button variant="destructive"><AlertCircle className="mr-2 h-4 w-4" /> Delete</Button>
                </div>
              </Showcase>
            </div>
          </Section>

          <Separator />

          {/* ── Badges ── */}
          <Section title="Badges">
            <div className="flex flex-wrap gap-2">
              <Badge>Default</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge variant="destructive">Destructive</Badge>
              <Badge variant="outline">Outline</Badge>
            </div>
          </Section>

          <Separator />

          {/* ── Form Controls ── */}
          <Section title="Form Controls">
            <div className="grid grid-cols-2 gap-6">
              <Showcase label="Input">
                <div className="space-y-2">
                  <Input placeholder="Default input" />
                  <Input type="email" placeholder="Email" />
                  <Input disabled placeholder="Disabled" />
                </div>
              </Showcase>

              <Showcase label="Textarea">
                <Textarea placeholder="Type your message here..." />
              </Showcase>

              <Showcase label="Select">
                <Select>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a framework" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="react">React</SelectItem>
                    <SelectItem value="svelte">Svelte</SelectItem>
                    <SelectItem value="vue">Vue</SelectItem>
                    <SelectItem value="solid">Solid</SelectItem>
                  </SelectContent>
                </Select>
              </Showcase>

              <Showcase label="Checkbox, Switch & Slider">
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Checkbox id="terms" />
                    <label htmlFor="terms" className="text-sm">Accept terms</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox id="disabled" disabled />
                    <label htmlFor="disabled" className="text-sm text-muted-foreground">Disabled</label>
                  </div>
                  <Separator />
                  <div className="flex items-center gap-3">
                    <Switch id="airplane" />
                    <label htmlFor="airplane" className="text-sm">Airplane mode</label>
                  </div>
                  <Separator />
                  <Slider defaultValue={[50]} max={100} step={1} className="w-full" />
                </div>
              </Showcase>
            </div>
          </Section>

          <Separator />

          {/* ── Cards ── */}
          <Section title="Cards">
            <div className="grid grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Card Title</CardTitle>
                  <CardDescription>Card description with supporting text.</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm">
                    This is the card content area. Use it for any kind of body content.
                  </p>
                </CardContent>
                <CardFooter className="gap-2">
                  <Button variant="outline" size="sm">Cancel</Button>
                  <Button size="sm">Save</Button>
                </CardFooter>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Notifications</CardTitle>
                  <CardDescription>You have 3 unread messages.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {["New review comment", "PR approved", "Build succeeded"].map((msg) => (
                    <div key={msg} className="flex items-center gap-3">
                      <div className="h-2 w-2 rounded-full bg-primary" />
                      <p className="text-sm">{msg}</p>
                    </div>
                  ))}
                </CardContent>
                <CardFooter>
                  <Button variant="outline" size="sm" className="w-full">
                    <Check className="mr-2 h-4 w-4" /> Mark all as read
                  </Button>
                </CardFooter>
              </Card>
            </div>
          </Section>

          <Separator />

          {/* ── Alerts ── */}
          <Section title="Alerts">
            <div className="space-y-3">
              <Alert>
                <Terminal className="h-4 w-4" />
                <AlertTitle>Heads up!</AlertTitle>
                <AlertDescription>
                  You can add components to your app using the CLI.
                </AlertDescription>
              </Alert>
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>
                  Your session has expired. Please log in again.
                </AlertDescription>
              </Alert>
            </div>
          </Section>

          <Separator />

          {/* ── Data Display ── */}
          <Section title="Data Display">
            <div className="grid grid-cols-3 gap-6">
              <Showcase label="Avatars">
                <div className="flex items-center gap-3">
                  <Avatar>
                    <AvatarImage src="https://github.com/shadcn.png" alt="shadcn" />
                    <AvatarFallback>CN</AvatarFallback>
                  </Avatar>
                  <Avatar>
                    <AvatarFallback>AB</AvatarFallback>
                  </Avatar>
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="text-xs">SM</AvatarFallback>
                  </Avatar>
                </div>
              </Showcase>

              <Showcase label="Keyboard shortcuts">
                <div className="flex items-center gap-2">
                  <Kbd>Ctrl</Kbd>
                  <span className="text-xs text-muted-foreground">+</span>
                  <Kbd>K</Kbd>
                  <span className="text-xs text-muted-foreground ml-4">or</span>
                  <Kbd>Esc</Kbd>
                </div>
              </Showcase>

              <Showcase label="Tooltips">
                <div className="flex gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" size="sm">
                        <Info className="mr-2 h-3 w-3" /> Hover me
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>This is a tooltip</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              </Showcase>
            </div>
          </Section>

          <Separator />

          {/* ── Toggle ── */}
          <Section title="Toggle">
            <div className="flex gap-2">
              <Toggle aria-label="Toggle bold">
                <Bold className="h-4 w-4" />
              </Toggle>
              <Toggle aria-label="Toggle italic">
                <Italic className="h-4 w-4" />
              </Toggle>
              <Toggle aria-label="Toggle underline">
                <Underline className="h-4 w-4" />
              </Toggle>
              <Separator orientation="vertical" className="mx-1 h-10" />
              <Toggle variant="outline" aria-label="Toggle outline">
                <Bold className="h-4 w-4" />
              </Toggle>
            </div>
          </Section>

          <Separator />

          {/* ── Tabs ── */}
          <Section title="Tabs">
            <Tabs defaultValue="preview" className="w-full">
              <TabsList>
                <TabsTrigger value="preview">Preview</TabsTrigger>
                <TabsTrigger value="code">Code</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>
              <TabsContent value="preview">
                <Card>
                  <CardContent className="pt-6">
                    <p className="text-sm text-muted-foreground">
                      This is the preview tab content. Switch tabs to see other content.
                    </p>
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent value="code">
                <Card>
                  <CardContent className="pt-6">
                    <pre className="text-sm font-mono bg-muted p-3 rounded-md">
                      {`import { Button } from "@rev/ui"\n\nexport function App() {\n  return <Button>Click me</Button>\n}`}
                    </pre>
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent value="settings">
                <Card>
                  <CardContent className="pt-6 space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="text-sm">Dark mode</label>
                      <Switch />
                    </div>
                    <div className="flex items-center justify-between">
                      <label className="text-sm">Notifications</label>
                      <Switch defaultChecked />
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </Section>

          <Separator />

          {/* ── Accordion ── */}
          <Section title="Accordion">
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="item-1">
                <AccordionTrigger>What components are included?</AccordionTrigger>
                <AccordionContent>
                  Button, Badge, Card, Input, Textarea, Select, Checkbox, Switch, Slider,
                  Tabs, Accordion, Avatar, Alert, Tooltip, Toggle, Separator, Skeleton, Spinner, and Kbd.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="item-2">
                <AccordionTrigger>How are they styled?</AccordionTrigger>
                <AccordionContent>
                  All components use Tailwind CSS with CSS variables for theming.
                  Colors are defined in the globals.css using HSL values that support
                  both light and dark modes.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="item-3">
                <AccordionTrigger>Can I customize them?</AccordionTrigger>
                <AccordionContent>
                  Yes. Each component accepts a className prop for overrides, and the
                  design tokens in globals.css control the overall theme.
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </Section>

          <Separator />

          {/* ── Loading States ── */}
          <Section title="Loading States">
            <div className="grid grid-cols-2 gap-6">
              <Showcase label="Skeleton">
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-10 w-10 rounded-full" />
                    <div className="space-y-2 flex-1">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </div>
                  <Skeleton className="h-24 w-full" />
                </div>
              </Showcase>

              <Showcase label="Spinner">
                <div className="flex items-center gap-4">
                  <Spinner className="size-4" />
                  <Spinner className="size-6" />
                  <Spinner className="size-8" />
                  <Button disabled>
                    <Spinner className="mr-2" /> Loading...
                  </Button>
                </div>
              </Showcase>
            </div>
          </Section>

          <Separator />

          {/* ── Separator ── */}
          <Section title="Separators">
            <div className="space-y-4">
              <div>
                <p className="text-sm mb-2">Horizontal</p>
                <Separator />
              </div>
              <div className="flex items-center gap-4 h-6">
                <p className="text-sm">Item 1</p>
                <Separator orientation="vertical" />
                <p className="text-sm">Item 2</p>
                <Separator orientation="vertical" />
                <p className="text-sm">Item 3</p>
              </div>
            </div>
          </Section>

          <div className="h-10" />
        </div>
      </div>
    </TooltipProvider>
  );
}
