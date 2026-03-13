"use client";

import React, { useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { hardhat } from "viem/chains";
import { Bars3Icon, BugAntIcon, ChartBarIcon, HomeIcon, ShoppingBagIcon } from "@heroicons/react/24/outline";
import { FaucetButton, RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { useOutsideClick, useTargetNetwork } from "~~/hooks/scaffold-eth";

type HeaderMenuLink = {
  label: string;
  href: string;
  icon?: React.ReactNode;
};

export const menuLinks: HeaderMenuLink[] = [
  {
    label: "Home",
    href: "/",
    icon: <HomeIcon className="h-4 w-4" />,
  },
  {
    label: "Farm",
    href: "/farm",
    icon: <span className="text-sm leading-none">🌾</span>,
  },
  {
    label: "Market",
    href: "/market",
    icon: <ChartBarIcon className="h-4 w-4" />,
  },
  {
    label: "Shop",
    href: "/shop",
    icon: <ShoppingBagIcon className="h-4 w-4" />,
  },
  {
    label: "Debug",
    href: "/debug",
    icon: <BugAntIcon className="h-4 w-4" />,
  },
];

export const HeaderMenuLinks = () => {
  const pathname = usePathname();

  return (
    <>
      {menuLinks.map(({ label, href, icon }) => {
        const isActive = pathname === href;
        return (
          <li key={href}>
            <Link
              href={href}
              passHref
              className={`${
                isActive ? "bg-primary/15 text-primary font-semibold" : "text-base-content/70"
              } hover:bg-primary/10 hover:text-primary py-1.5 px-3 text-sm rounded-full gap-2 grid grid-flow-col transition-colors`}
            >
              {icon}
              <span>{label}</span>
            </Link>
          </li>
        );
      })}
    </>
  );
};

/**
 * Site header
 */
export const Header = () => {
  const { targetNetwork } = useTargetNetwork();
  const isLocalNetwork = targetNetwork.id === hardhat.id;

  const burgerMenuRef = useRef<HTMLDetailsElement>(null);
  useOutsideClick(burgerMenuRef, () => {
    burgerMenuRef?.current?.removeAttribute("open");
  });

  return (
    <div className="sticky top-0 navbar bg-base-100/90 backdrop-blur-sm min-h-0 shrink-0 justify-between z-20 border-b border-base-200 px-0 sm:px-2">
      <div className="navbar-start w-auto lg:w-1/2">
        <details className="dropdown" ref={burgerMenuRef}>
          <summary className="ml-1 btn btn-ghost btn-sm lg:hidden">
            <Bars3Icon className="h-5 w-5" />
          </summary>
          <ul
            className="menu menu-compact dropdown-content mt-3 p-2 shadow-lg bg-base-100 rounded-box w-52 border border-base-200"
            onClick={() => {
              burgerMenuRef?.current?.removeAttribute("open");
            }}
          >
            <HeaderMenuLinks />
          </ul>
        </details>

        <Link href="/" passHref className="hidden lg:flex items-center gap-2 ml-4 mr-6 shrink-0">
          <span className="text-2xl leading-none" aria-hidden="true">
            🌿
          </span>
          <div className="flex flex-col leading-none">
            <span className="font-extrabold text-base text-primary tracking-tight">On-Chain Farm</span>
            <span className="text-[10px] text-base-content/50 uppercase tracking-widest">Play · Build · Earn</span>
          </div>
        </Link>

        <ul className="hidden lg:flex lg:flex-nowrap menu menu-horizontal px-1 gap-1">
          <HeaderMenuLinks />
        </ul>
      </div>

      <div className="navbar-end grow mr-4 gap-2">
        <RainbowKitCustomConnectButton />
        {isLocalNetwork && <FaucetButton />}
      </div>
    </div>
  );
};
